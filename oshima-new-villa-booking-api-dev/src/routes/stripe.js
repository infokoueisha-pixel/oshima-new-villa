import { HOLD_MINUTES } from "../config.js";
import { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate } from "../lib/dates.js";
import { withCors, jsonError } from "../lib/http.js";
import { sendCancellationCompletionEmail, sendAdminCancellationNotificationEmail } from "../services/emails.js";
import { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse } from "../services/booking.js";

export async function handleStripeRoutes(request, env, url) {
/*
 * Stripe 接続確認
 */
if (
  url.pathname === "/api/stripe-test" &&
  request.method === "GET"
) {
  try {
    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/account",
      {
        headers: {
          Authorization:
            `Bearer ${env.STRIPE_SECRET_KEY}`,
        },
      }
    );

    if (!stripeResponse.ok) {
      console.error(
        "Stripe connection failed:",
        stripeResponse.status
      );

      return Response.json(
        {
          ok: false,
          stripe_connected: false,
        },
        { status: 500 }
      );
    }

    const account =
      await stripeResponse.json();

    const testMode =
      env.STRIPE_SECRET_KEY.startsWith(
        "sk_test_"
      ) ||
      env.STRIPE_SECRET_KEY.startsWith(
        "rk_test_"
      );

    return Response.json({
      ok: true,
      stripe_connected: true,
      test_mode: testMode,
      country: account.country,
      default_currency:
        account.default_currency,
    });
  } catch (error) {
    console.error(
      "Stripe test error:",
      error
    );

    return Response.json(
      {
        ok: false,
        stripe_connected: false,
      },
      { status: 500 }
    );
  }
}

/*
 * Stripe Checkout Session作成
 */
if (
  url.pathname === "/api/checkout" &&
  request.method === "POST"
) {
  try {
    let body;

    try {
      body = await request.json();
    } catch {
      return withCors(
        jsonError("invalid_json"),
        request
      );
    }

    const bookingCode =
      String(body.booking_code || "").trim();

    if (!bookingCode) {
      return withCors(
        jsonError(
          "booking_code_required"
        ),
        request
      );
    }

    /*
     * 仮予約を取得
     */
    const booking = await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.product_id,
          p.name AS product_name,

          b.check_in_date,
          b.check_out_date,

          b.guest_count,
          b.total_jpy,

          b.status,
          b.payment_status,

          b.customer_email,
          b.hold_expires_at,

          b.stripe_checkout_session_id

        FROM bookings b
        JOIN products p
          ON p.id = b.product_id

        WHERE b.public_booking_code = ?
        LIMIT 1
      `)
      .bind(bookingCode)
      .first();

    if (!booking) {
      return withCors(
        jsonError(
          "booking_not_found",
          404
        ),
        request
      );
    }

    /*
     * すでに決済済み
     */
    if (
      booking.status === "confirmed" ||
      booking.payment_status === "paid"
    ) {
      return withCors(
        jsonError(
          "booking_already_paid",
          409
        ),
        request
      );
    }

    /*
     * 決済可能な予約状態か
     */
    if (
      booking.status !== "pending_payment" ||
      booking.payment_status !== "unpaid"
    ) {
      return withCors(
        jsonError(
          "booking_not_payable",
          409
        ),
        request
      );
    }

    /*
     * すでにStripe Sessionがある場合は
     * 新しく作らず、既存Sessionを確認
     */
    if (booking.stripe_checkout_session_id) {
      const existingStripeResponse =
        await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(
            booking.stripe_checkout_session_id
          )}`,
          {
            headers: {
              Authorization:
                `Bearer ${env.STRIPE_SECRET_KEY}`,
            },
          }
        );

      if (existingStripeResponse.ok) {
        const existingSession =
          await existingStripeResponse.json();

        if (
          existingSession.status === "open" &&
          existingSession.url
        ) {
          return withCors(
            Response.json({
              ok: true,

              booking_code:
                booking.public_booking_code,

              checkout_session_id:
                existingSession.id,

              checkout_url:
                existingSession.url,

              checkout_status:
                existingSession.status,

              expires_at:
                existingSession.expires_at,

              checkout_replayed: true,
            }),
            request
          );
        }

        if (
          existingSession.status === "complete"
        ) {
          return withCors(
            Response.json({
              ok: true,

              booking_code:
                booking.public_booking_code,

              checkout_session_id:
                existingSession.id,

              checkout_status: "complete",

              checkout_replayed: true,
            }),
            request
          );
        }
      }
    }

    /*
     * 仮押さえ期限を確認
     */
    if (!booking.hold_expires_at) {
      return withCors(
        jsonError(
          "hold_expired",
          409
        ),
        request
      );
    }

    const holdExpiresAt =
      new Date(
        booking.hold_expires_at
          .replace(" ", "T") + "Z"
      );

    if (
      Number.isNaN(
        holdExpiresAt.getTime()
      ) ||
      holdExpiresAt.getTime() <= Date.now()
    ) {
      return withCors(
        jsonError(
          "hold_expired",
          409
        ),
        request
      );
    }

    /*
     * StripeではCheckout Sessionの
     * expires_atが最低30分必要なので、
     * 通信時間の余裕を持たせて31分にする。
     */
    const checkoutExpiresUnix =
      Math.floor(Date.now() / 1000) +
      31 * 60;

    const checkoutExpiresSql =
      toSqlUtc(
        new Date(
          checkoutExpiresUnix * 1000
        )
      );

    /*
     * Stripe Checkoutのデータ
     */
    const stripeBody =
      new URLSearchParams();

    stripeBody.set(
      "mode",
      "payment"
    );

    stripeBody.set(
      "client_reference_id",
      booking.id
    );

    stripeBody.set(
      "customer_email",
      booking.customer_email
    );

    stripeBody.set(
      "locale",
      "ja"
    );

    stripeBody.set(
  "success_url",
  `http://localhost:4321/booking/success/?session_id={CHECKOUT_SESSION_ID}`
);

stripeBody.set(
  "cancel_url",
  `http://localhost:4321/booking/cancel/?booking_code=${encodeURIComponent(
    booking.public_booking_code
  )}`
);

    stripeBody.set(
      "expires_at",
      String(checkoutExpiresUnix)
    );

    /*
     * 商品
     */
    stripeBody.set(
      "line_items[0][price_data][currency]",
      "jpy"
    );

    stripeBody.set(
      "line_items[0][price_data][unit_amount]",
      String(booking.total_jpy)
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][name]",
      `大島ニュービラ｜${booking.product_name}`
    );

    stripeBody.set(
      "line_items[0][price_data][product_data][description]",
      `${booking.check_in_date} ～ ${booking.check_out_date} / ${booking.guest_count}名`
    );

    stripeBody.set(
      "line_items[0][quantity]",
      "1"
    );

    /*
     * Stripe側にも予約情報を保持
     */
    stripeBody.set(
      "metadata[booking_id]",
      booking.id
    );

    stripeBody.set(
      "metadata[booking_code]",
      booking.public_booking_code
    );

    stripeBody.set(
      "payment_intent_data[metadata][booking_id]",
      booking.id
    );

    stripeBody.set(
      "payment_intent_data[metadata][booking_code]",
      booking.public_booking_code
    );

    /*
     * Stripe Session作成
     *
     * 同じ予約で通信再送されても
     * Stripe側で二重Sessionを
     * 作りにくくする。
     */
    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "Content-Type":
              "application/x-www-form-urlencoded",

            "Idempotency-Key":
              `onv-checkout-${booking.id}`,
          },

          body:
            stripeBody.toString(),
        }
      );

    if (!stripeResponse.ok) {
      const stripeError =
        await stripeResponse.json();

      console.error(
        "Stripe Checkout creation failed:",
        stripeError?.error?.type,
        stripeError?.error?.code
      );

      return withCors(
        jsonError(
          "stripe_checkout_creation_failed",
          502
        ),
        request
      );
    }

    const session =
      await stripeResponse.json();

    /*
     * Stripe Sessionと
     * SALVIAの仮押さえ期限を
     * 同じ時刻へ更新
     */
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bookings
          SET
            stripe_checkout_session_id = ?,
            hold_expires_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'pending_payment'
            AND payment_status = 'unpaid'
        `)
        .bind(
          session.id,
          checkoutExpiresSql,
          booking.id
        ),

      env.DB
        .prepare(`
          UPDATE inventory_nights
          SET
            expires_at = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE allocation_ref = ?
            AND allocation_type = 'hold'
        `)
        .bind(
          checkoutExpiresSql,
          booking.id
        ),
    ]);

    return withCors(
  Response.json(
    {
      ok: true,

      booking_code:
        booking.public_booking_code,

      checkout_session_id:
        session.id,

      checkout_url:
        session.url,

      checkout_status:
        session.status,

      expires_at:
        session.expires_at,

      total_price_jpy:
        booking.total_jpy,

      checkout_replayed: false,
    },
    { status: 201 }
  ),
  request
);
  } catch (error) {
    console.error(
      "Checkout API error:",
      error
    );

    return withCors(
      jsonError(
        "internal_server_error",
        500
      ),
      request
    );
  }
}

  return null;
}
