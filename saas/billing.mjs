/**
 * Stripe billing: checkout, webhook, customer portal.
 */

import Stripe from "stripe";
import { Router } from "express";
import { requireLogin } from "./auth.mjs";

const PRICE_TO_PLAN = {};

function initPriceMap() {
  if (process.env.STRIPE_STARTER_PRICE_ID) {
    PRICE_TO_PLAN[process.env.STRIPE_STARTER_PRICE_ID] = "starter";
  }
  if (process.env.STRIPE_PRO_PRICE_ID) {
    PRICE_TO_PLAN[process.env.STRIPE_PRO_PRICE_ID] = "pro";
  }
}

function getPriceId(plan) {
  if (plan === "starter") return process.env.STRIPE_STARTER_PRICE_ID;
  if (plan === "pro") return process.env.STRIPE_PRO_PRICE_ID;
  return null;
}

export function createBillingRouter(db) {
  const router = Router();
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const APP_URL = () => process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;

  initPriceMap();

  // --- Create Checkout Session ---

  router.post("/api/billing/checkout", requireLogin, async (req, res) => {
    try {
      const tenant = await db.getTenantById(req.session.tenantId);
      if (!tenant) return res.redirect("/login");

      const plan = req.body.plan;
      const priceId = getPriceId(plan);
      if (!priceId) return res.status(400).send("Invalid plan");

      const sessionParams = {
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${APP_URL()}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL()}/dashboard`,
        customer_email: tenant.stripe_customer_id ? undefined : tenant.email,
        customer: tenant.stripe_customer_id || undefined,
        client_reference_id: tenant.id,
        payment_method_types: undefined, // let Stripe use dynamic payment methods
      };

      const session = await stripe.checkout.sessions.create(sessionParams);
      res.redirect(303, session.url);
    } catch (err) {
      console.error("Checkout error:", err);
      req.session.flashMsg = { type: "error", text: "Failed to start checkout." };
      res.redirect("/dashboard");
    }
  });

  // --- Checkout Success (redirect from Stripe) ---

  router.get("/api/billing/success", requireLogin, async (req, res) => {
    try {
      const sessionId = req.query.session_id;
      if (!sessionId) return res.redirect("/dashboard");

      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"],
      });

      if (session.status !== "complete") {
        req.session.flashMsg = { type: "error", text: "Checkout was not completed." };
        return res.redirect("/dashboard");
      }

      const tenantId = session.client_reference_id;
      const subscription = session.subscription;
      const priceId = subscription.items?.data?.[0]?.price?.id;
      const plan = PRICE_TO_PLAN[priceId] || "starter";

      await db.updateTenant(tenantId, {
        plan,
        stripe_customer_id: session.customer,
        stripe_subscription_id: subscription.id,
      });

      req.session.flashMsg = { type: "success", text: `Upgraded to ${plan.charAt(0).toUpperCase() + plan.slice(1)}!` };
      res.redirect("/dashboard");
    } catch (err) {
      console.error("Success callback error:", err);
      req.session.flashMsg = { type: "error", text: "Something went wrong verifying your subscription." };
      res.redirect("/dashboard");
    }
  });

  // --- Customer Portal ---

  router.post("/api/billing/portal", requireLogin, async (req, res) => {
    try {
      const tenant = await db.getTenantById(req.session.tenantId);
      if (!tenant?.stripe_customer_id) {
        req.session.flashMsg = { type: "error", text: "No billing account found." };
        return res.redirect("/dashboard");
      }

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: tenant.stripe_customer_id,
        return_url: `${APP_URL()}/dashboard`,
      });

      res.redirect(303, portalSession.url);
    } catch (err) {
      console.error("Portal error:", err);
      req.session.flashMsg = { type: "error", text: "Failed to open billing portal." };
      res.redirect("/dashboard");
    }
  });

  return router;
}

// --- Webhook handler (called with raw body, outside normal middleware) ---

export function createWebhookHandler(db) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  initPriceMap();

  return async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;
          const tenantId = session.client_reference_id;
          if (tenantId && session.subscription) {
            const subscription = await stripe.subscriptions.retrieve(session.subscription);
            const priceId = subscription.items?.data?.[0]?.price?.id;
            const plan = PRICE_TO_PLAN[priceId] || "starter";
            await db.updateTenant(tenantId, {
              plan,
              stripe_customer_id: session.customer,
              stripe_subscription_id: subscription.id,
            });
            console.log(`Webhook: tenant ${tenantId} upgraded to ${plan}`);
          }
          break;
        }

        case "customer.subscription.updated": {
          const subscription = event.data.object;
          const priceId = subscription.items?.data?.[0]?.price?.id;
          const plan = PRICE_TO_PLAN[priceId];
          if (!plan) {
            console.error(`Webhook: unknown price ID ${priceId} for subscription ${subscription.id} — no plan change made`);
            break;
          }
          // Find tenant by stripe_subscription_id
          const result = await db.pool.query(
            `SELECT id FROM tenants WHERE stripe_subscription_id = $1`,
            [subscription.id]
          );
          if (result.rows[0]) {
            await db.updateTenant(result.rows[0].id, { plan });
            console.log(`Webhook: subscription ${subscription.id} updated to ${plan}`);
          }
          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;
          const result = await db.pool.query(
            `SELECT id FROM tenants WHERE stripe_subscription_id = $1`,
            [subscription.id]
          );
          if (result.rows[0]) {
            await db.updateTenant(result.rows[0].id, {
              plan: "free",
              stripe_subscription_id: null,
            });
            console.log(`Webhook: subscription ${subscription.id} cancelled, reverted to free`);
          }
          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;
          const result = await db.pool.query(
            `SELECT id FROM tenants WHERE stripe_customer_id = $1`,
            [invoice.customer]
          );
          if (result.rows[0]) {
            await db.updateTenant(result.rows[0].id, { status: "suspended" });
            console.log(`Webhook: tenant suspended due to payment failure (customer: ${invoice.customer})`);
          }
          break;
        }
      }
    } catch (err) {
      console.error(`Webhook handler error for ${event.type}:`, err);
    }

    res.json({ received: true });
  };
}
