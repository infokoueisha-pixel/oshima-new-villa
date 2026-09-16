const HOLD_MINUTES = 30;

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const date = new Date(`${value}T00:00:00Z`);

  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function getStayDates(checkIn, checkOut) {
  const dates = [];

  const current = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  while (current < end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return dates;
}

function toSqlUtc(date) {
  return date
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

function createPublicBookingCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);

  crypto.getRandomValues(bytes);

  let code = "ONV-";

  for (const byte of bytes) {
    code += chars[byte % chars.length];
  }

  return code;
}

const ALLOWED_ORIGINS = new Set([
  "http://localhost:4321",
  "http://127.0.0.1:4321",
  "https://oshima-new-villa.com",
  "https://www.oshima-new-villa.com",
]);

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");

  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
  "Content-Type, Idempotency-Key, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };

  if (
    origin &&
    ALLOWED_ORIGINS.has(origin)
  ) {
    headers["Access-Control-Allow-Origin"] =
      origin;
  }

  return headers;
}

function withCors(response, request) {
  const headers = new Headers(
    response.headers
  );

  const corsHeaders =
    getCorsHeaders(request);

  for (
    const [key, value] of
      Object.entries(corsHeaders)
  ) {
    headers.set(key, value);
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    }
  );
}

function jsonError(error, status = 400, extra = {}) {
  return Response.json(
    {
      ok: false,
      error,
      ...extra,
    },
    { status }
  );
}

function getTokyoToday() {
  const parts = new Intl.DateTimeFormat(
    "en-US",
    {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day"
    ) {
      values[part.type] = part.value;
    }
  }

  return `${values.year}-${values.month}-${values.day}`;
}

function getCancellationPolicyRate(
  checkInDate,
  reasonCode
) {
  /*
   * 船・航空便の正式欠航
   * または施設都合
   * → キャンセル料なし
   */
  if (
    reasonCode === "transport_cancellation" ||
    reasonCode === "facility_reason"
  ) {
    return 0;
  }

  const today = getTokyoToday();

  const toUtc = (dateString) => {
    const [year, month, day] =
      dateString.split("-").map(Number);

    return Date.UTC(
      year,
      month - 1,
      day
    );
  };

  const daysUntilCheckIn = Math.floor(
    (
      toUtc(checkInDate) -
      toUtc(today)
    ) /
      86400000
  );

  // 8日前まで：無料
  if (daysUntilCheckIn >= 8) {
    return 0;
  }

  // 7〜4日前：20%
  if (daysUntilCheckIn >= 4) {
    return 20;
  }

  // 3〜2日前：50%
  if (daysUntilCheckIn >= 2) {
    return 50;
  }

  // 前日：80%
  if (daysUntilCheckIn >= 1) {
    return 80;
  }

  // 当日・それ以降：100%
  return 100;
}


function getCancellationReasonLabel(
  reasonCode
) {
  const labels = {
    guest_request: "お客様都合",
    transport_cancellation:
      "船・航空便の正式欠航",
    facility_reason: "施設都合",
    other: "その他",
  };

  return labels[reasonCode] || "その他";
}

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/*
 * お客様へキャンセル・返金完了メールを送信する。
 *
 * メール障害では予約キャンセル・Stripe返金を失敗扱いにしない。
 * cancellation_email_deliveries で二重送信を防止する。
 */
async function sendCancellationCompletionEmail(
  env,
  bookingId
) {
  const emailBooking =
    await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.customer_name,
          b.customer_email,
          b.check_in_date,
          b.check_out_date,
          b.guest_count,
          b.total_jpy,

          p.name AS product_name,

          c.reason_code,
          c.policy_rate,
          c.cancellation_fee_jpy,
          c.refund_amount_jpy,
          c.stripe_refund_id,
          c.stripe_refund_status

        FROM bookings b

        JOIN products p
          ON p.id = b.product_id

        JOIN booking_cancellations c
          ON c.booking_id = b.id

        WHERE b.id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (!emailBooking?.customer_email) {
    return "skipped";
  }

  const existingDelivery =
    await env.DB
      .prepare(`
        SELECT
          id,
          status
        FROM cancellation_email_deliveries
        WHERE booking_id = ?
        LIMIT 1
      `)
      .bind(bookingId)
      .first();

  if (existingDelivery?.status === "sent") {
    return "already_sent";
  }

  const deliveryId =
    existingDelivery?.id ||
    crypto.randomUUID();

  if (!existingDelivery) {
    await env.DB
      .prepare(`
        INSERT INTO cancellation_email_deliveries (
          id,
          booking_id,
          recipient_email,
          status
        )
        VALUES (?, ?, ?, 'pending')
      `)
      .bind(
        deliveryId,
        bookingId,
        emailBooking.customer_email
      )
      .run();
  } else {
    await env.DB
      .prepare(`
        UPDATE cancellation_email_deliveries
        SET
          recipient_email = ?,
          status = 'pending',
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        emailBooking.customer_email,
        deliveryId
      )
      .run();
  }

  const formattedTotal =
    Number(
      emailBooking.total_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedFee =
    Number(
      emailBooking.cancellation_fee_jpy || 0
    ).toLocaleString("ja-JP");

  const formattedRefund =
    Number(
      emailBooking.refund_amount_jpy || 0
    ).toLocaleString("ja-JP");

  const reasonLabel =
    getCancellationReasonLabel(
      emailBooking.reason_code
    );

  let refundMessageText = "";

  let refundMessageHtml = "";

  if (
    Number(
      emailBooking.refund_amount_jpy || 0
    ) <= 0
  ) {
    refundMessageText =
      "今回の返金額は0円です。";

    refundMessageHtml =
      "今回の返金額は<strong>0円</strong>です。";
  } else if (
    emailBooking.stripe_refund_status ===
    "succeeded"
  ) {
    refundMessageText =
      "Stripeで返金処理は完了しています。カード会社側での返金反映時期は、ご利用のカード会社によって異なります。";

    refundMessageHtml =
      "Stripeで<strong>返金処理は完了しています。</strong><br>カード会社側での返金反映時期は、ご利用のカード会社によって異なります。";
  } else {
    refundMessageText =
      "Stripeで返金処理を受け付けています。カード会社側への反映まで時間がかかる場合があります。";

    refundMessageHtml =
      "Stripeで<strong>返金処理を受け付けています。</strong><br>カード会社側への反映まで時間がかかる場合があります。";
  }

  const subject =
    `【大島ニュービラ】ご予約キャンセルのお知らせ｜${emailBooking.public_booking_code}`;

  const textBody = `
${emailBooking.customer_name} 様

大島ニュービラをご予約いただき、ありがとうございました。
以下のご予約について、キャンセル手続きが完了しました。

■ 予約番号
${emailBooking.public_booking_code}

■ 宿泊施設
${emailBooking.product_name}

■ チェックイン
${emailBooking.check_in_date}

■ チェックアウト
${emailBooking.check_out_date}

■ 宿泊人数
${emailBooking.guest_count}名

■ キャンセル理由
${reasonLabel}

■ お支払い済み金額
¥${formattedTotal}

■ キャンセル料率
${emailBooking.policy_rate}%

■ キャンセル料
¥${formattedFee}

■ 返金額
¥${formattedRefund}

${refundMessageText}

ご不明な点がございましたら、大島ニュービラまでお問い合わせください。

大島ニュービラ
https://oshima-new-villa.com/

※このメールは自社予約システムより自動送信されています。
  `.trim();

  const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.8;
">

  <h2 style="margin-bottom:8px;">
    大島ニュービラ
  </h2>

  <p>
    ${escapeEmailHtml(
      emailBooking.customer_name
    )} 様
  </p>

  <p>
    大島ニュービラをご予約いただき、
    ありがとうございました。<br>
    以下のご予約について、
    <strong>キャンセル手続きが完了しました。</strong>
  </p>

  <div style="
    background:#f7f7f7;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeEmailHtml(
        emailBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeEmailHtml(
        emailBooking.product_name
      )}
    </p>

    <p>
      <strong>宿泊日</strong><br>
      ${escapeEmailHtml(
        emailBooking.check_in_date
      )}
      ～
      ${escapeEmailHtml(
        emailBooking.check_out_date
      )}
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${emailBooking.guest_count}名
    </p>

    <p>
      <strong>キャンセル理由</strong><br>
      ${escapeEmailHtml(
        reasonLabel
      )}
    </p>

  </div>

  <div style="
    border:1px solid #ddd;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>お支払い済み金額</strong><br>
      ¥${formattedTotal}
    </p>

    <p>
      <strong>キャンセル料率</strong><br>
      ${emailBooking.policy_rate}%
    </p>

    <p>
      <strong>キャンセル料</strong><br>
      ¥${formattedFee}
    </p>

    <p style="margin-bottom:8px;">
      <strong>返金額</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedRefund}
      </span>
    </p>

    <p style="
      margin-top:16px;
      margin-bottom:0;
      font-size:14px;
    ">
      ${refundMessageHtml}
    </p>

  </div>

  <p>
    ご不明な点がございましたら、
    大島ニュービラまでお問い合わせください。
  </p>

  <p>
    <a href="https://oshima-new-villa.com/">
      大島ニュービラ公式サイト
    </a>
  </p>

  <p style="
    margin-top:32px;
    font-size:13px;
    color:#666;
  ">
    ※このメールは大島ニュービラ
    自社予約システムより
    自動送信されています。
  </p>

</div>
  `.trim();

  const resendResponse =
    await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.RESEND_API_KEY}`,

          "Content-Type":
            "application/json",

          "Idempotency-Key":
            `onv-cancellation-email-${bookingId}`,
        },

        body: JSON.stringify({
          from:
            "大島ニュービラ <booking@oshima-new-villa.com>",

          to: [
            emailBooking.customer_email,
          ],

          subject,

          text: textBody,

          html: htmlBody,
        }),
      }
    );

  if (resendResponse.ok) {
    const resendResult =
      await resendResponse.json();

    await env.DB
      .prepare(`
        UPDATE cancellation_email_deliveries
        SET
          resend_email_id = ?,
          status = 'sent',
          last_error = NULL,
          sent_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .bind(
        resendResult.id,
        deliveryId
      )
      .run();

    return "sent";
  }

  const resendError =
    await resendResponse.json()
      .catch(() => null);

  const errorMessage =
    String(
      resendError?.message ||
      resendError?.name ||
      "resend_error"
    ).slice(0, 500);

  await env.DB
    .prepare(`
      UPDATE cancellation_email_deliveries
      SET
        status = 'failed',
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(
      errorMessage,
      deliveryId
    )
    .run();

  console.error(
    "Cancellation completion email failed:",
    errorMessage
  );

  return "failed";
}

async function sha256(value) {
  const encoded = new TextEncoder().encode(value);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    encoded
  );

  return [...new Uint8Array(hash)]
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

async function createFingerprint(data) {
  const normalized = {
    product_id: data.product_id,
    check_in: data.check_in,
    check_out: data.check_out,
    guest_count: data.guest_count,
    customer_name: data.customer_name,
    customer_email: data.customer_email,
    customer_phone: data.customer_phone || null,
  };

  return sha256(JSON.stringify(normalized));
}

async function getAvailability(
  env,
  productId,
  checkIn,
  checkOut
) {
  const stayDates = getStayDates(
    checkIn,
    checkOut
  );

  const nights = stayDates.length;

  const product = await env.DB
    .prepare(`
      SELECT
        p.id,
        p.name,
        p.max_guests,
        p.min_nights,
        p.currency,
        p.cancellation_policy_id
      FROM products p
      WHERE p.id = ?
        AND p.status = 'active'
      LIMIT 1
    `)
    .bind(productId)
    .first();

  if (!product) {
    return {
      ok: false,
      error: "product_not_found",
    };
  }

  const rateResult = await env.DB
    .prepare(`
      SELECT
        stay_date,
        price_jpy,
        is_open,
        min_nights_override
      FROM rate_calendar
      WHERE product_id = ?
        AND stay_date >= ?
        AND stay_date < ?
      ORDER BY stay_date
    `)
    .bind(
      productId,
      checkIn,
      checkOut
    )
    .all();

  const rateMap = new Map(
    rateResult.results.map(
      (row) => [row.stay_date, row]
    )
  );

  const missingDates =
    stayDates.filter(
      (date) => !rateMap.has(date)
    );

  const closedDates =
    stayDates.filter((date) => {
      const row = rateMap.get(date);

      return (
        row &&
        row.is_open !== 1
      );
    });

  const checkInRate =
    rateMap.get(checkIn);

  const minimumNights =
    checkInRate?.min_nights_override ??
    product.min_nights;

  const inventoryResult = await env.DB
    .prepare(`
      SELECT DISTINCT
        i.stay_date
      FROM inventory_nights i
      JOIN product_units pu
        ON pu.unit_id = i.unit_id
      WHERE pu.product_id = ?
        AND i.stay_date >= ?
        AND i.stay_date < ?
        AND (
          i.allocation_type = 'booking'
          OR (
            i.allocation_type = 'hold'
            AND i.expires_at IS NOT NULL
            AND datetime(i.expires_at)
              > CURRENT_TIMESTAMP
          )
        )
      ORDER BY i.stay_date
    `)
    .bind(
      productId,
      checkIn,
      checkOut
    )
    .all();

  const occupiedDates =
    inventoryResult.results.map(
      (row) => row.stay_date
    );

  const nightlyRates =
    stayDates.map((date) => {
      const rate =
        rateMap.get(date);

      return {
        stay_date: date,
        price_jpy:
          rate?.price_jpy ?? null,
        is_open:
          rate?.is_open === 1,
      };
    });

  const totalPrice =
    missingDates.length === 0
      ? nightlyRates.reduce(
          (sum, row) =>
            sum + row.price_jpy,
          0
        )
      : null;

  let reason = "available";

  if (nights < minimumNights) {
    reason =
      "minimum_nights_not_met";
  } else if (
    missingDates.length > 0
  ) {
    reason =
      "rate_not_configured";
  } else if (
    closedDates.length > 0
  ) {
    reason =
      "sales_closed";
  } else if (
    occupiedDates.length > 0
  ) {
    reason =
      "already_reserved";
  }

  return {
    ok: true,

    product,
    stayDates,
    nights,
    nightlyRates,
    totalPrice,
    minimumNights,

    available:
      reason === "available",

    reason,

    unavailableDates: {
      rate_not_configured:
        missingDates,

      sales_closed:
        closedDates,

      already_reserved:
        occupiedDates,
    },
  };
}

async function getBookingByIdempotencyKey(
  env,
  idempotencyKey
) {
  return env.DB
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

        b.hold_expires_at,

        b.idempotency_key,
        b.idempotency_fingerprint,

        p.currency
      FROM bookings b
      JOIN products p
        ON p.id = b.product_id
      WHERE b.idempotency_key = ?
      LIMIT 1
    `)
    .bind(idempotencyKey)
    .first();
}

function existingBookingResponse(
  booking,
  replayed = true
) {
  const nights =
    getStayDates(
      booking.check_in_date,
      booking.check_out_date
    ).length;

  return Response.json({
    ok: true,

    booking_id:
      booking.id,

    booking_code:
      booking.public_booking_code,

    status:
      booking.status,

    payment_status:
      booking.payment_status,

    product_id:
      booking.product_id,

    product_name:
      booking.product_name,

    check_in:
      booking.check_in_date,

    check_out:
      booking.check_out_date,

    nights,

    guest_count:
      booking.guest_count,

    currency:
      booking.currency,

    total_price_jpy:
      booking.total_jpy,

    hold_expires_at:
      booking.hold_expires_at,

    hold_minutes:
      HOLD_MINUTES,

    idempotency_replayed:
      replayed,
  });
}

export default {
  async fetch(request, env) {

  /*
   * Browser CORS preflight
   */
  if (
    request.method === "OPTIONS"
  ) {
    const origin =
      request.headers.get("Origin");

    if (
      !origin ||
      !ALLOWED_ORIGINS.has(origin)
    ) {
      return new Response(
        null,
        { status: 403 }
      );
    }

    return new Response(
      null,
      {
        status: 204,
        headers:
          getCorsHeaders(request),
      }
    );
  }

  const url =
    new URL(request.url);

    /*
     * API動作確認
     */
    if (url.pathname === "/") {
      return Response.json({
        ok: true,
        service:
          "oshima-new-villa-booking-api-dev",
      });
    }

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

/*
 * Stripe Webhook
 * 決済完了 → 予約確定
 */
if (
  url.pathname === "/api/stripe/webhook" &&
  request.method === "POST"
) {
  try {
    /*
     * 重要：
     * Stripe署名はJSON化する前の
     * 生のBodyで検証する
     */
    const rawBody = await request.text();

    const stripeSignature =
      request.headers.get("Stripe-Signature");

    if (!stripeSignature) {
      return Response.json(
        {
          ok: false,
          error: "stripe_signature_missing",
        },
        { status: 400 }
      );
    }

    /*
     * Stripe-Signatureを解析
     *
     * 例：
     * t=1234567890,v1=xxxxxx
     */
    const signatureParts =
      stripeSignature.split(",");

    let timestamp = null;
    const signatures = [];

    for (const part of signatureParts) {
      const [key, value] =
        part.split("=");

      if (key === "t") {
        timestamp = value;
      }

      if (key === "v1") {
        signatures.push(value);
      }
    }

    if (
      !timestamp ||
      signatures.length === 0
    ) {
      return Response.json(
        {
          ok: false,
          error: "invalid_stripe_signature",
        },
        { status: 400 }
      );
    }

    /*
     * 古すぎるWebhookを拒否
     * 許容：5分
     */
    const timestampNumber =
      Number(timestamp);

    const nowSeconds =
      Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(timestampNumber) ||
      Math.abs(
        nowSeconds - timestampNumber
      ) > 300
    ) {
      return Response.json(
        {
          ok: false,
          error: "stripe_signature_expired",
        },
        { status: 400 }
      );
    }

    /*
     * Stripe仕様：
     * HMAC-SHA256(
     *   webhook_secret,
     *   timestamp + "." + raw_body
     * )
     */
    const signedPayload =
      `${timestamp}.${rawBody}`;

    const cryptoKey =
      await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(
          env.STRIPE_WEBHOOK_SECRET
        ),
        {
          name: "HMAC",
          hash: "SHA-256",
        },
        false,
        ["sign"]
      );

    const signatureBuffer =
      await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        new TextEncoder().encode(
          signedPayload
        )
      );

    const expectedSignature =
      [...new Uint8Array(signatureBuffer)]
        .map((byte) =>
          byte
            .toString(16)
            .padStart(2, "0")
        )
        .join("");

    /*
     * タイミング差を小さくする比較
     */
    function constantTimeEqual(a, b) {
      if (a.length !== b.length) {
        return false;
      }

      let difference = 0;

      for (
        let i = 0;
        i < a.length;
        i++
      ) {
        difference |=
          a.charCodeAt(i) ^
          b.charCodeAt(i);
      }

      return difference === 0;
    }

    const signatureValid =
      signatures.some((signature) =>
        constantTimeEqual(
          signature,
          expectedSignature
        )
      );

    if (!signatureValid) {
      console.error(
        "Stripe webhook signature verification failed"
      );

      return Response.json(
        {
          ok: false,
          error:
            "stripe_signature_verification_failed",
        },
        { status: 400 }
      );
    }

    /*
     * 署名検証後に初めてJSON化
     */
    let event;

    try {
      event = JSON.parse(rawBody);
    } catch {
      return Response.json(
        {
          ok: false,
          error: "invalid_webhook_json",
        },
        { status: 400 }
      );
    }

    /*
     * 同じStripeイベントを
     * すでに処理済みなら即終了
     */
    const existingEvent =
      await env.DB
        .prepare(`
          SELECT stripe_event_id
          FROM stripe_webhook_events
          WHERE stripe_event_id = ?
          LIMIT 1
        `)
        .bind(event.id)
        .first();

    if (existingEvent) {
      return Response.json({
        ok: true,
        already_processed: true,
      });
    }

    /*
     * 今は
     * checkout.session.completed
     * だけ処理
     */
    if (
      event.type !==
      "checkout.session.completed"
    ) {
      await env.DB
        .prepare(`
          INSERT INTO stripe_webhook_events (
            stripe_event_id,
            event_type,
            booking_id,
            status
          ) VALUES (?, ?, NULL, 'ignored')
        `)
        .bind(
          event.id,
          event.type
        )
        .run();

      return Response.json({
        ok: true,
        ignored: true,
      });
    }

    const session =
      event.data?.object;

    if (!session) {
      return Response.json(
        {
          ok: false,
          error:
            "stripe_session_missing",
        },
        { status: 400 }
      );
    }

    /*
     * 支払済みであることを確認
     */
    if (
      session.payment_status !== "paid"
    ) {
      await env.DB
        .prepare(`
          INSERT INTO stripe_webhook_events (
            stripe_event_id,
            event_type,
            booking_id,
            status
          ) VALUES (?, ?, ?, 'ignored')
        `)
        .bind(
          event.id,
          event.type,
          session.client_reference_id ||
            null
        )
        .run();

      return Response.json({
        ok: true,
        ignored: true,
        reason: "payment_not_paid",
      });
    }

    const bookingId =
      session.client_reference_id;

    if (!bookingId) {
      return Response.json(
        {
          ok: false,
          error:
            "booking_reference_missing",
        },
        { status: 400 }
      );
    }

    /*
     * 大島ニュービラ側の
     * 予約を取得
     */
    const booking =
      await env.DB
        .prepare(`
          SELECT
            id,
            public_booking_code,
            total_jpy,
            status,
            payment_status,
            stripe_checkout_session_id
          FROM bookings
          WHERE id = ?
          LIMIT 1
        `)
        .bind(bookingId)
        .first();

    if (!booking) {
      console.error(
        "Webhook booking not found:",
        bookingId
      );

      return Response.json(
        {
          ok: false,
          error: "booking_not_found",
        },
        { status: 404 }
      );
    }

    /*
     * Stripe Session ID照合
     */
    if (
      booking.stripe_checkout_session_id !==
      session.id
    ) {
      console.error(
        "Checkout Session mismatch"
      );

      return Response.json(
        {
          ok: false,
          error:
            "checkout_session_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 金額照合
     *
     * JPYはStripeでも
     * 105000 = ¥105,000
     */
    if (
      Number(session.amount_total) !==
      Number(booking.total_jpy)
    ) {
      console.error(
        "Payment amount mismatch"
      );

      return Response.json(
        {
          ok: false,
          error:
            "payment_amount_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 通貨照合
     */
    if (
      String(session.currency)
        .toLowerCase() !== "jpy"
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "payment_currency_mismatch",
        },
        { status: 400 }
      );
    }

    /*
     * 最終確定処理
     *
     * 予約：
     * pending_payment → confirmed
     *
     * 決済：
     * unpaid → paid
     *
     * 在庫：
     * hold → booking
     *
     * Webhookイベント：
     * processed として保存
     */
    try {
      await env.DB.batch([
        env.DB
          .prepare(`
            INSERT INTO stripe_webhook_events (
              stripe_event_id,
              event_type,
              booking_id,
              status
            ) VALUES (?, ?, ?, 'processed')
          `)
          .bind(
            event.id,
            event.type,
            booking.id
          ),

        env.DB
          .prepare(`
            UPDATE bookings
            SET
              status = 'confirmed',
              payment_status = 'paid',
              stripe_payment_intent_id = ?,
              confirmed_at =
                CURRENT_TIMESTAMP,
              hold_expires_at = NULL,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
              AND status =
                'pending_payment'
              AND payment_status =
                'unpaid'
          `)
          .bind(
            session.payment_intent ||
              null,
            booking.id
          ),

        env.DB
          .prepare(`
            UPDATE inventory_nights
            SET
              allocation_type =
                'booking',
              expires_at = NULL,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE allocation_ref = ?
              AND allocation_type =
                'hold'
          `)
          .bind(booking.id),
      ]);
    } catch (error) {
      /*
       * Stripeが同じイベントを
       * 同時再送した場合など
       */
      const processedEvent =
        await env.DB
          .prepare(`
            SELECT stripe_event_id
            FROM stripe_webhook_events
            WHERE stripe_event_id = ?
            LIMIT 1
          `)
          .bind(event.id)
          .first();

      if (processedEvent) {
        return Response.json({
          ok: true,
          already_processed: true,
        });
      }

      throw error;
    }

/*
 * お客様へ予約確定メール
 *
 * メール送信に失敗しても
 * 予約そのものは confirmed / paid のまま維持する
 */
let bookingConfirmationEmailStatus =
  "skipped";

try {
  const emailBooking =
    await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.customer_name,
          b.customer_email,
          b.check_in_date,
          b.check_out_date,
          b.guest_count,
          b.total_jpy,
          b.cancellation_policy_snapshot,
          p.name AS product_name

        FROM bookings b

        JOIN products p
          ON p.id = b.product_id

        WHERE b.id = ?
        LIMIT 1
      `)
      .bind(booking.id)
      .first();

  if (emailBooking?.customer_email) {
    /*
     * すでに送信済みか確認
     */
    const existingDelivery =
      await env.DB
        .prepare(`
          SELECT
            id,
            status
          FROM email_deliveries
          WHERE booking_id = ?
            AND email_type =
              'booking_confirmation'
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (
      existingDelivery?.status ===
      "sent"
    ) {
      bookingConfirmationEmailStatus =
        "already_sent";
    } else {
      const deliveryId =
        existingDelivery?.id ||
        crypto.randomUUID();

      /*
       * 先に送信予定をDBへ記録
       */
      if (!existingDelivery) {
        await env.DB
          .prepare(`
            INSERT INTO email_deliveries (
              id,
              booking_id,
              email_type,
              recipient_email,
              status
            )
            VALUES (
              ?,
              ?,
              'booking_confirmation',
              ?,
              'pending'
            )
          `)
          .bind(
            deliveryId,
            booking.id,
            emailBooking.customer_email
          )
          .run();
      }

      const escapeHtml = (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#039;");

      const checkInTime =
        Date.parse(
          `${emailBooking.check_in_date}T00:00:00Z`
        );

      const checkOutTime =
        Date.parse(
          `${emailBooking.check_out_date}T00:00:00Z`
        );

      const nights =
        Math.max(
          1,
          Math.round(
            (
              checkOutTime -
              checkInTime
            ) /
              86400000
          )
        );

      const formattedAmount =
        Number(
          emailBooking.total_jpy
        ).toLocaleString("ja-JP");

      const policyText =
        emailBooking
          .cancellation_policy_snapshot ||
        "";

      const policyHtml =
        escapeHtml(policyText)
          .replace(/\n/g, "<br>");

      const subject =
        `【大島ニュービラ】ご予約が確定しました｜${emailBooking.public_booking_code}`;

      const textBody = `
${emailBooking.customer_name} 様

大島ニュービラをご予約いただき、ありがとうございます。
以下の内容でご予約が確定しました。

■ 予約番号
${emailBooking.public_booking_code}

■ 宿泊施設
${emailBooking.product_name}

■ チェックイン
${emailBooking.check_in_date}

■ チェックアウト
${emailBooking.check_out_date}

■ 泊数
${nights}泊

■ 宿泊人数
${emailBooking.guest_count}名

■ お支払い済み金額
¥${formattedAmount}

お支払いは完了しています。

■ キャンセルポリシー
${policyText}

チェックイン方法・アクセス・ご宿泊にあたっての重要事項は、
ご宿泊前に改めてご案内いたします。

大島ニュービラ
https://oshima-new-villa.com/

※このメールは自社予約システムより自動送信されています。
      `.trim();

      const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.8;
">

  <h2 style="margin-bottom:8px;">
    大島ニュービラ
  </h2>

  <p>
    ${escapeHtml(
      emailBooking.customer_name
    )} 様
  </p>

  <p>
    この度は大島ニュービラをご予約いただき、
    ありがとうございます。<br>
    以下の内容で
    <strong>ご予約が確定しました。</strong>
  </p>

  <div style="
    background:#f7f7f7;
    padding:20px;
    margin:24px 0;
    border-radius:8px;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeHtml(
        emailBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeHtml(
        emailBooking.product_name
      )}
    </p>

    <p>
      <strong>チェックイン</strong><br>
      ${escapeHtml(
        emailBooking.check_in_date
      )}
    </p>

    <p>
      <strong>チェックアウト</strong><br>
      ${escapeHtml(
        emailBooking.check_out_date
      )}
    </p>

    <p>
      <strong>泊数</strong><br>
      ${nights}泊
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${emailBooking.guest_count}名
    </p>

    <p>
      <strong>お支払い済み金額</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedAmount}
      </span>
    </p>

    <p style="margin-bottom:0;">
      ✓ お支払いは完了しています。
    </p>

  </div>

  <h3>キャンセルポリシー</h3>

  <p style="font-size:14px;">
    ${policyHtml}
  </p>

  <hr style="
    border:0;
    border-top:1px solid #ddd;
    margin:28px 0;
  ">

  <p>
    チェックイン方法・アクセス・
    ご宿泊にあたっての重要事項は、
    ご宿泊前に改めてご案内いたします。
  </p>

  <p>
    <a href="https://oshima-new-villa.com/">
      大島ニュービラ公式サイト
    </a>
  </p>

  <p style="
    margin-top:32px;
    font-size:13px;
    color:#666;
  ">
    ※このメールは大島ニュービラ
    自社予約システムより
    自動送信されています。
  </p>

</div>
      `.trim();

      /*
       * Resendで送信
       */
      const resendResponse =
        await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${env.RESEND_API_KEY}`,

              "Content-Type":
                "application/json",

              /*
               * 同じ予約の確認メールを
               * 二重送信しない
               */
              "Idempotency-Key":
                `onv-booking-confirmation-${booking.id}`,
            },

            body: JSON.stringify({
              from:
                "大島ニュービラ <booking@oshima-new-villa.com>",

              to: [
                emailBooking.customer_email,
              ],

              subject,

              text: textBody,

              html: htmlBody,
            }),
          }
        );

      if (resendResponse.ok) {
        const resendResult =
          await resendResponse.json();

        await env.DB
          .prepare(`
            UPDATE email_deliveries
            SET
              resend_email_id = ?,
              status = 'sent',
              last_error = NULL,
              sent_at =
                CURRENT_TIMESTAMP,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            resendResult.id,
            deliveryId
          )
          .run();

        bookingConfirmationEmailStatus =
          "sent";
      } else {
        const resendError =
          await resendResponse.json();

        const errorMessage =
          String(
            resendError?.message ||
            resendError?.name ||
            "resend_error"
          ).slice(0, 500);

        await env.DB
          .prepare(`
            UPDATE email_deliveries
            SET
              status = 'failed',
              last_error = ?,
              updated_at =
                CURRENT_TIMESTAMP
            WHERE id = ?
          `)
          .bind(
            errorMessage,
            deliveryId
          )
          .run();

        bookingConfirmationEmailStatus =
          "failed";

        console.error(
          "Booking confirmation email failed:",
          errorMessage
        );
      }
    }
  }
} catch (emailError) {
  /*
   * メール障害では
   * Stripe Webhookを失敗扱いにしない
   */
  bookingConfirmationEmailStatus =
    "failed";

  console.error(
    "Booking confirmation email error:",
    emailError
  );
}

/*
 * 管理者へ新規予約通知メール
 *
 * 通知失敗でも予約・決済は
 * confirmed / paid のまま維持する
 */
let adminBookingNotificationStatus =
  "skipped";

try {
  const adminEmail =
    String(
      env.ADMIN_NOTIFICATION_EMAIL || ""
    ).trim();

  if (adminEmail) {
    const adminBooking =
      await env.DB
        .prepare(`
          SELECT
            b.id,
            b.public_booking_code,

            b.customer_name,
            b.customer_email,
            b.customer_phone,

            b.check_in_date,
            b.check_out_date,

            b.guest_count,
            b.total_jpy,

            p.name AS product_name

          FROM bookings b

          JOIN products p
            ON p.id = b.product_id

          WHERE b.id = ?
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (adminBooking) {
      /*
       * すでに管理者通知を
       * 送信済みか確認
       */
      const existingAdminDelivery =
        await env.DB
          .prepare(`
            SELECT
              id,
              status
            FROM email_deliveries
            WHERE booking_id = ?
              AND email_type =
                'admin_booking_notification'
            LIMIT 1
          `)
          .bind(booking.id)
          .first();

      if (
        existingAdminDelivery?.status ===
        "sent"
      ) {
        adminBookingNotificationStatus =
          "already_sent";
      } else {
        const deliveryId =
          existingAdminDelivery?.id ||
          crypto.randomUUID();

        if (!existingAdminDelivery) {
          await env.DB
            .prepare(`
              INSERT INTO email_deliveries (
                id,
                booking_id,
                email_type,
                recipient_email,
                status
              )
              VALUES (
                ?,
                ?,
                'admin_booking_notification',
                ?,
                'pending'
              )
            `)
            .bind(
              deliveryId,
              booking.id,
              adminEmail
            )
            .run();
        }

        /*
         * 泊数計算
         */
        const checkInTime =
          Date.parse(
            `${adminBooking.check_in_date}T00:00:00Z`
          );

        const checkOutTime =
          Date.parse(
            `${adminBooking.check_out_date}T00:00:00Z`
          );

        const nights =
          Math.max(
            1,
            Math.round(
              (
                checkOutTime -
                checkInTime
              ) /
                86400000
            )
          );

        const formattedAmount =
          Number(
            adminBooking.total_jpy
          ).toLocaleString("ja-JP");

        const escapeHtml = (value) =>
          String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll(
              "'",
              "&#039;"
            );

        const subject =
          `【新規予約】${adminBooking.product_name}｜${adminBooking.check_in_date}〜${adminBooking.check_out_date}｜${adminBooking.guest_count}名｜¥${formattedAmount}`;

        const textBody = `
大島ニュービラに新しい予約が入りました。

■ 予約番号
${adminBooking.public_booking_code}

■ 宿泊施設
${adminBooking.product_name}

■ チェックイン
${adminBooking.check_in_date}

■ チェックアウト
${adminBooking.check_out_date}

■ 泊数
${nights}泊

■ 宿泊人数
${adminBooking.guest_count}名

■ 売上
¥${formattedAmount}

■ 決済
支払済み

■ 予約者名
${adminBooking.customer_name}

■ メールアドレス
${adminBooking.customer_email}

■ 電話番号
${adminBooking.customer_phone || "未登録"}

Stripe決済および予約確定処理は完了しています。

大島ニュービラ 自社予約システム
        `.trim();

        const htmlBody = `
<div style="
  max-width:640px;
  margin:0 auto;
  font-family:
    Arial,
    'Hiragino Kaku Gothic ProN',
    'Yu Gothic',
    sans-serif;
  color:#222;
  line-height:1.7;
">

  <h2>
    新規予約が入りました
  </h2>

  <div style="
    background:#f7f7f7;
    padding:20px;
    border-radius:8px;
    margin:20px 0;
  ">

    <p>
      <strong>予約番号</strong><br>
      ${escapeHtml(
        adminBooking.public_booking_code
      )}
    </p>

    <p>
      <strong>宿泊施設</strong><br>
      ${escapeHtml(
        adminBooking.product_name
      )}
    </p>

    <p>
      <strong>宿泊日</strong><br>
      ${escapeHtml(
        adminBooking.check_in_date
      )}
      ～
      ${escapeHtml(
        adminBooking.check_out_date
      )}
      （${nights}泊）
    </p>

    <p>
      <strong>宿泊人数</strong><br>
      ${adminBooking.guest_count}名
    </p>

    <p>
      <strong>売上</strong><br>
      <span style="
        font-size:22px;
        font-weight:bold;
      ">
        ¥${formattedAmount}
      </span>
    </p>

    <p>
      <strong>決済状況</strong><br>
      ✓ 支払済み
    </p>

  </div>

  <h3>予約者情報</h3>

  <p>
    <strong>氏名</strong><br>
    ${escapeHtml(
      adminBooking.customer_name
    )}
  </p>

  <p>
    <strong>メール</strong><br>
    ${escapeHtml(
      adminBooking.customer_email
    )}
  </p>

  <p>
    <strong>電話番号</strong><br>
    ${escapeHtml(
      adminBooking.customer_phone ||
        "未登録"
    )}
  </p>

  <hr style="
    border:0;
    border-top:1px solid #ddd;
    margin:28px 0;
  ">

  <p style="
    font-size:13px;
    color:#666;
  ">
    Stripe決済および
    大島ニュービラ自社予約システムの
    予約確定処理は完了しています。
  </p>

</div>
        `.trim();

        const resendResponse =
          await fetch(
            "https://api.resend.com/emails",
            {
              method: "POST",

              headers: {
                Authorization:
                  `Bearer ${env.RESEND_API_KEY}`,

                "Content-Type":
                  "application/json",

                "Idempotency-Key":
                  `onv-admin-booking-${booking.id}`,
              },

              body: JSON.stringify({
                from:
                  "大島ニュービラ予約システム <booking@oshima-new-villa.com>",

                to: [
                  adminEmail,
                ],

                subject,

                text: textBody,

                html: htmlBody,
              }),
            }
          );

        if (resendResponse.ok) {
          const resendResult =
            await resendResponse.json();

          await env.DB
            .prepare(`
              UPDATE email_deliveries
              SET
                resend_email_id = ?,
                status = 'sent',
                last_error = NULL,
                sent_at =
                  CURRENT_TIMESTAMP,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              resendResult.id,
              deliveryId
            )
            .run();

          adminBookingNotificationStatus =
            "sent";
        } else {
          const resendError =
            await resendResponse.json();

          const errorMessage =
            String(
              resendError?.message ||
              resendError?.name ||
              "resend_error"
            ).slice(0, 500);

          await env.DB
            .prepare(`
              UPDATE email_deliveries
              SET
                status = 'failed',
                last_error = ?,
                updated_at =
                  CURRENT_TIMESTAMP
              WHERE id = ?
            `)
            .bind(
              errorMessage,
              deliveryId
            )
            .run();

          adminBookingNotificationStatus =
            "failed";

          console.error(
            "Admin booking notification failed:",
            errorMessage
          );
        }
      }
    }
  }
} catch (adminEmailError) {
  /*
   * 管理者メール障害でも
   * 予約・決済は成功扱い
   */
  adminBookingNotificationStatus =
    "failed";

  console.error(
    "Admin booking notification error:",
    adminEmailError
  );
}

    return Response.json({
  ok: true,

  booking_code:
    booking.public_booking_code,

  booking_status:
    "confirmed",

  payment_status:
    "paid",

  booking_confirmation_email:
    bookingConfirmationEmailStatus,

  admin_booking_notification:
    adminBookingNotificationStatus,
});
  } catch (error) {
    console.error(
      "Stripe webhook error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "stripe_webhook_internal_error",
      },
      { status: 500 }
    );
  }
}



/*
 * 公開用：決済中断後の予約状態確認
 *
 * booking_code を受け取り、
 * 再決済できる状態かどうかだけを返す。
 * 個人情報・金額・Stripe URLは返さない。
 */
if (
  url.pathname === "/api/booking-payment-status" &&
  request.method === "POST"
) {
  try {
    let body;

    try {
      body = await request.json();
    } catch {
      return withCors(
        jsonError("invalid_json", 400),
        request
      );
    }

    const bookingCode =
      String(body.booking_code || "").trim();

    if (
      !bookingCode ||
      !/^ONV-[A-Z0-9]{10}$/.test(bookingCode)
    ) {
      return withCors(
        jsonError(
          "invalid_booking_code",
          400
        ),
        request
      );
    }

    const booking =
      await env.DB
        .prepare(`
          SELECT
            id,
            public_booking_code,
            status,
            payment_status,
            hold_expires_at
          FROM bookings
          WHERE public_booking_code = ?
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

    if (
      booking.status === "confirmed" &&
      booking.payment_status === "paid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "confirmed",
        }),
        request
      );
    }

    if (booking.status === "cancelled") {
      return withCors(
        Response.json({
          ok: true,
          state: "cancelled",
        }),
        request
      );
    }

    if (booking.status === "expired") {
      return withCors(
        Response.json({
          ok: true,
          state: "expired",
        }),
        request
      );
    }

    if (
      booking.status === "pending_payment" &&
      booking.payment_status === "unpaid"
    ) {
      if (!booking.hold_expires_at) {
        return withCors(
          Response.json({
            ok: true,
            state: "expired",
          }),
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
          Response.json({
            ok: true,
            state: "expired",
          }),
          request
        );
      }

      return withCors(
        Response.json({
          ok: true,
          state: "retryable",
          hold_expires_at:
            booking.hold_expires_at,
        }),
        request
      );
    }

    return withCors(
      Response.json({
        ok: true,
        state: "not_payable",
      }),
      request
    );
  } catch (error) {
    console.error(
      "Booking payment status API error:",
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

/*
 * 公開用：決済完了後の予約確定確認
 *
 * Stripe Checkout の session_id を
 * ブラウザから受け取り、
 * D1上で confirmed / paid になった予約だけ
 * 予約詳細を返す。
 *
 * session_id はURLクエリではなく
 * POST bodyで受け取る。
 */
if (
  url.pathname === "/api/booking-confirmation" &&
  request.method === "POST"
) {
  try {
    let body;

    try {
      body = await request.json();
    } catch {
      return withCors(
        jsonError("invalid_json", 400),
        request
      );
    }

    const sessionId =
      String(body.session_id || "").trim();

    if (
      !sessionId ||
      !sessionId.startsWith("cs_") ||
      sessionId.length > 255
    ) {
      return withCors(
        jsonError(
          "invalid_checkout_session_id",
          400
        ),
        request
      );
    }

    const booking =
      await env.DB
        .prepare(`
          SELECT
            b.id,
            b.public_booking_code,
            b.product_id,
            p.name AS product_name,

            b.check_in_date,
            b.check_out_date,
            CAST(
              julianday(b.check_out_date) -
              julianday(b.check_in_date)
              AS INTEGER
            ) AS nights,

            b.guest_count,
            b.total_jpy,

            b.status,
            b.payment_status,

            b.customer_email,
            b.confirmed_at,
            b.cancelled_at

          FROM bookings b

          JOIN products p
            ON p.id = b.product_id

          WHERE
            b.stripe_checkout_session_id = ?
          LIMIT 1
        `)
        .bind(sessionId)
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

    if (booking.status === "cancelled") {
      return withCors(
        Response.json({
          ok: true,
          state: "cancelled",
          booking_code:
            booking.public_booking_code,
        }),
        request
      );
    }

    if (
      booking.status ===
        "pending_payment" &&
      booking.payment_status === "unpaid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "processing",
        }),
        request
      );
    }

    if (
      booking.status === "confirmed" &&
      booking.payment_status === "paid"
    ) {
      return withCors(
        Response.json({
          ok: true,
          state: "confirmed",

          booking: {
            booking_code:
              booking.public_booking_code,

            product_id:
              booking.product_id,

            product_name:
              booking.product_name,

            check_in:
              booking.check_in_date,

            check_out:
              booking.check_out_date,

            nights:
              booking.nights,

            guest_count:
              booking.guest_count,

            total_jpy:
              booking.total_jpy,

            customer_email:
              booking.customer_email,

            confirmed_at:
              booking.confirmed_at,
          },
        }),
        request
      );
    }

    return withCors(
      Response.json({
        ok: true,
        state: "not_confirmed",
      }),
      request
    );
  } catch (error) {
    console.error(
      "Booking confirmation API error:",
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

/*
 * Resend メール送信テスト
 * 開発完了後に削除する
 */
if (
  url.pathname === "/api/email-test" &&
  request.method === "POST"
) {
  try {
    /*
     * テストAPIの不正利用防止
     */
    const testToken =
      request.headers.get(
        "X-Email-Test-Token"
      );

    if (
      !env.EMAIL_TEST_SECRET ||
      testToken !==
        env.EMAIL_TEST_SECRET
    ) {
      return Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      );
    }

    /*
     * 送信先取得
     */
    let body;

    try {
      body = await request.json();
    } catch {
      return Response.json(
        {
          ok: false,
          error: "invalid_json",
        },
        { status: 400 }
      );
    }

    const to =
      String(body.to || "")
        .trim()
        .toLowerCase();

    if (
      !to ||
      to.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(to)
    ) {
      return Response.json(
        {
          ok: false,
          error:
            "invalid_email_address",
        },
        { status: 400 }
      );
    }

    /*
     * 同じテスト操作の
     * 二重送信防止
     */
    const recipientHash =
      await sha256(to);

    const resendResponse =
      await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${env.RESEND_API_KEY}`,

            "Content-Type":
              "application/json",

            "Idempotency-Key":
              `onv-email-test-${recipientHash.slice(
                0,
                24
              )}`,
          },

          body: JSON.stringify({
            from:
              "大島ニュービラ <booking@oshima-new-villa.com>",

            to: [to],

            subject:
              "【大島ニュービラ】メール送信テスト",

            text:
              "大島ニュービラ自社予約システムからのメール送信テストです。正常に受信できています。",

            html: `
              <div style="font-family: Arial, 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif; line-height: 1.8; color: #222;">
                <h2>大島ニュービラ</h2>

                <p>
                  自社予約システムからの
                  メール送信テストです。
                </p>

                <p>
                  このメールを受信できていれば、
                  Cloudflare Worker から Resend を経由した
                  メール送信は正常に動作しています。
                </p>

                <hr style="border:0;border-top:1px solid #ddd;margin:24px 0;">

                <p style="font-size:13px;color:#666;">
                  ※これは開発環境から送信されたテストメールです。
                </p>
              </div>
            `,
          }),
        }
      );

    if (!resendResponse.ok) {
      const resendError =
        await resendResponse.json();

      console.error(
        "Resend email test failed:",
        resendResponse.status,
        resendError?.name ||
          resendError?.message ||
          "unknown_error"
      );

      return Response.json(
        {
          ok: false,
          error:
            "email_send_failed",
        },
        { status: 502 }
      );
    }

    const resendResult =
      await resendResponse.json();

    return Response.json({
      ok: true,
      email_sent: true,
      resend_email_id:
        resendResult.id,
    });
  } catch (error) {
    console.error(
      "Email test error:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "email_test_internal_error",
      },
      { status: 500 }
    );
  }
}

/*
 * Stripeテスト用
 * Checkout成功後の遷移先
 */
if (
  url.pathname === "/checkout/success" &&
  request.method === "GET"
) {
  return Response.json({
    ok: true,
    message:
      "決済完了画面です。現在は開発環境です。",
  });
}

/*
 * Stripeテスト用
 * Checkoutキャンセル時の遷移先
 */
if (
  url.pathname === "/checkout/cancel" &&
  request.method === "GET"
) {
  return Response.json({
    ok: true,
    message:
      "決済は完了していません。現在は開発環境です。",
  });
}

    /*
     * 空室・料金確認
     */
    if (
      url.pathname ===
        "/api/availability" &&
      request.method === "GET"
    ) {
      try {
        const productId =
          url.searchParams.get(
            "product"
          );

        const checkIn =
          url.searchParams.get(
            "check_in"
          );

        const checkOut =
          url.searchParams.get(
            "check_out"
          );

        if (
          !productId ||
          !checkIn ||
          !checkOut
        ) {
          return jsonError(
            "product_check_in_and_check_out_are_required"
          );
        }

        if (
          !isValidDate(checkIn) ||
          !isValidDate(checkOut)
        ) {
          return jsonError(
            "invalid_date_format"
          );
        }

        if (
          checkOut <= checkIn
        ) {
          return jsonError(
            "check_out_must_be_after_check_in"
          );
        }

        const nights =
          getStayDates(
            checkIn,
            checkOut
          ).length;

        if (
          nights < 1 ||
          nights > 30
        ) {
          return jsonError(
            "stay_length_not_allowed"
          );
        }

        const result =
          await getAvailability(
            env,
            productId,
            checkIn,
            checkOut
          );

        if (!result.ok) {
          return jsonError(
            result.error,
            404
          );
        }

        return withCors(
          Response.json({
          ok: true,

          product_id:
            result.product.id,

          product_name:
            result.product.name,

          check_in:
            checkIn,

          check_out:
            checkOut,

          nights:
            result.nights,

          minimum_nights:
            result.minimumNights,

          max_guests:
            result.product
              .max_guests,

          currency:
            result.product
              .currency,

          nightly_rates:
            result.nightlyRates,

          total_price_jpy:
            result.totalPrice,

          available:
            result.available,

          reason:
            result.reason,

          unavailable_dates:
      result.unavailableDates,
  }),
  request
);
      } catch (error) {
        console.error(
          "Availability error:",
          error
        );

        return jsonError(
          "internal_server_error",
          500
        );
      }
    }

    /*
     * 仮予約作成
     */
    if (
      url.pathname ===
        "/api/holds" &&
      request.method === "POST"
    ) {
      try {
        /*
         * Idempotency-Key
         */
        const idempotencyKey =
          request.headers.get(
            "Idempotency-Key"
          );

        if (!idempotencyKey) {
          return jsonError(
            "idempotency_key_required"
          );
        }

        if (
          idempotencyKey.length < 8 ||
          idempotencyKey.length > 128
        ) {
          return jsonError(
            "invalid_idempotency_key"
          );
        }

        /*
         * JSON取得
         */
        let body;

        try {
          body =
            await request.json();
        } catch {
          return jsonError(
            "invalid_json"
          );
        }

        let {
          product_id,
          check_in,
          check_out,
          guest_count,
          customer_name,
          customer_email,
          customer_phone,
          terms_accepted,
          cancellation_policy_accepted,
        } = body;

        /*
         * 必須項目
         */
        if (
          !product_id ||
          !check_in ||
          !check_out ||
          !customer_name ||
          !customer_email
        ) {
          return jsonError(
            "required_fields_are_missing"
          );
        }

        /*
         * 正規化
         */
        product_id =
          String(product_id).trim();

        customer_name =
          String(customer_name).trim();

        customer_email =
          String(customer_email)
            .trim()
            .toLowerCase();

        customer_phone =
          customer_phone == null
            ? null
            : String(
                customer_phone
              ).trim();

        const parsedGuestCount =
          Number(guest_count);

        /*
         * 入力値チェック
         */
        if (
          !isValidDate(check_in) ||
          !isValidDate(check_out)
        ) {
          return jsonError(
            "invalid_date_format"
          );
        }

        if (
          check_out <= check_in
        ) {
          return jsonError(
            "check_out_must_be_after_check_in"
          );
        }

        if (
          !Number.isInteger(
            parsedGuestCount
          ) ||
          parsedGuestCount < 1
        ) {
          return jsonError(
            "invalid_guest_count"
          );
        }

        if (
          customer_name.length < 1 ||
          customer_name.length > 100
        ) {
          return jsonError(
            "invalid_customer_name"
          );
        }

        if (
          customer_email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
            .test(customer_email)
        ) {
          return jsonError(
            "invalid_customer_email"
          );
        }

        if (
          customer_phone &&
          customer_phone.length > 40
        ) {
          return jsonError(
            "invalid_customer_phone"
          );
        }

        if (
          terms_accepted !== true
        ) {
          return jsonError(
            "terms_must_be_accepted"
          );
        }

        if (
          cancellation_policy_accepted
            !== true
        ) {
          return jsonError(
            "cancellation_policy_must_be_accepted"
          );
        }

        const nights =
          getStayDates(
            check_in,
            check_out
          ).length;

        if (
          nights < 1 ||
          nights > 30
        ) {
          return jsonError(
            "stay_length_not_allowed"
          );
        }

        /*
         * リクエスト内容の指紋を作る
         */
        const fingerprint =
          await createFingerprint({
            product_id,
            check_in,
            check_out,
            guest_count:
              parsedGuestCount,
            customer_name,
            customer_email,
            customer_phone,
          });

        /*
         * 同じIdempotency-Keyが
         * すでに存在するか
         */
        const existingBooking =
          await getBookingByIdempotencyKey(
            env,
            idempotencyKey
          );

        if (existingBooking) {
          if (
            existingBooking
              .idempotency_fingerprint
            !== fingerprint
          ) {
            return jsonError(
              "idempotency_key_conflict",
              409
            );
          }

          /*
           * 同じキー＋同じ内容なら
           * 新規予約を作らず
           * 既存予約を返す
           */
          return existingBookingResponse(
            existingBooking,
            true
          );
        }

        /*
         * 料金・空室を
         * サーバー側で再確認
         */
        const availability =
          await getAvailability(
            env,
            product_id,
            check_in,
            check_out
          );

        if (!availability.ok) {
          return jsonError(
            availability.error,
            404
          );
        }

        if (
          parsedGuestCount >
          availability.product
            .max_guests
        ) {
          return jsonError(
            "guest_count_exceeds_capacity"
          );
        }

        if (
          !availability.available
        ) {
          return jsonError(
            "not_available",
            409,
            {
              reason:
                availability.reason,

              unavailable_dates:
                availability
                  .unavailableDates,
            }
          );
        }

        /*
         * キャンセルポリシー
         */
        const policyId =
          availability.product
            .cancellation_policy_id;

        if (!policyId) {
          return jsonError(
            "cancellation_policy_not_configured",
            500
          );
        }

        const policy =
          await env.DB
            .prepare(`
              SELECT
                id,
                version_code,
                policy_text
              FROM cancellation_policies
              WHERE id = ?
                AND status = 'active'
              LIMIT 1
            `)
            .bind(policyId)
            .first();

        if (!policy) {
          return jsonError(
            "cancellation_policy_not_found",
            500
          );
        }

        /*
         * 商品が使用する棟
         */
        const unitResult =
          await env.DB
            .prepare(`
              SELECT unit_id
              FROM product_units
              WHERE product_id = ?
              ORDER BY unit_id
            `)
            .bind(product_id)
            .all();

        const unitIds =
          unitResult.results.map(
            (row) => row.unit_id
          );

        if (
          unitIds.length === 0
        ) {
          return jsonError(
            "product_units_not_configured",
            500
          );
        }

        /*
         * 予約ID発行
         */
        const bookingId =
          crypto.randomUUID();

        const publicBookingCode =
          createPublicBookingCode();

        const expiresAtDate =
          new Date(
            Date.now() +
              HOLD_MINUTES *
                60 *
                1000
          );

        const expiresAt =
          toSqlUtc(
            expiresAtDate
          );

        /*
         * DBトランザクション
         */
        const statements = [];

        /*
         * 同日・同棟の
         * 期限切れholdだけ削除
         */
        for (
          const unitId of unitIds
        ) {
          for (
            const stayDate of
            availability.stayDates
          ) {
            statements.push(
              env.DB
                .prepare(`
                  DELETE
                  FROM inventory_nights
                  WHERE unit_id = ?
                    AND stay_date = ?
                    AND allocation_type = 'hold'
                    AND expires_at IS NOT NULL
                    AND datetime(expires_at)
                      <= CURRENT_TIMESTAMP
                `)
                .bind(
                  unitId,
                  stayDate
                )
            );
          }
        }

        /*
         * 予約本体
         */
        statements.push(
          env.DB
            .prepare(`
              INSERT INTO bookings (
                id,
                public_booking_code,

                product_id,

                check_in_date,
                check_out_date,

                guest_count,

                subtotal_jpy,
                discount_jpy,
                total_jpy,

                status,
                payment_status,

                customer_name,
                customer_email,
                customer_phone,

                cancellation_policy_version,
                cancellation_policy_snapshot,

                hold_expires_at,

                terms_accepted_at,
                cancellation_policy_accepted_at,

                idempotency_key,
                idempotency_fingerprint
              ) VALUES (
                ?, ?,
                ?,
                ?, ?,
                ?,
                ?, 0, ?,
                'pending_payment',
                'unpaid',
                ?, ?, ?,
                ?, ?,
                ?,
                CURRENT_TIMESTAMP,
                CURRENT_TIMESTAMP,
                ?, ?
              )
            `)
            .bind(
              bookingId,
              publicBookingCode,

              product_id,

              check_in,
              check_out,

              parsedGuestCount,

              availability.totalPrice,
              availability.totalPrice,

              customer_name,
              customer_email,
              customer_phone,

              policy.version_code,
              policy.policy_text,

              expiresAt,

              idempotencyKey,
              fingerprint
            )
        );

  /*
 * 期限切れ・未決済予約を
 * expiredへ変更する。
 */
statements.push(
  env.DB
    .prepare(`
      UPDATE bookings
      SET
        status = 'expired',
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'pending_payment'
        AND payment_status = 'unpaid'
        AND hold_expires_at IS NOT NULL
        AND datetime(hold_expires_at)
          <= CURRENT_TIMESTAMP
    `)
);

        /*
 * 宿泊日ごとの
 * 実在庫hold
 */
for (
  const unitId of unitIds
) {
  for (
    const stayDate of
      availability.stayDates
  ) {
    
    /*
     * 同じ部屋・宿泊日に残っている
     * 期限切れholdを回収する。
     *
     * booking と有効期限内のholdは
     * 絶対に削除しない。
     */
    statements.push(
      env.DB
        .prepare(`
          DELETE FROM inventory_nights
          WHERE unit_id = ?
            AND stay_date = ?
            AND allocation_type = 'hold'
            AND expires_at IS NOT NULL
            AND datetime(expires_at)
              <= CURRENT_TIMESTAMP
        `)
        .bind(
          unitId,
          stayDate
        )
    );

    statements.push(
      env.DB
        .prepare(`
          INSERT INTO inventory_nights (
            unit_id,
            stay_date,
            allocation_type,
            allocation_ref,
            expires_at
          ) VALUES (
            ?,
            ?,
            'hold',
            ?,
            ?
          )
        `)
        .bind(
          unitId,
          stayDate,
          bookingId,
          expiresAt
        )
    );
  }
}

        try {
          await env.DB.batch(
            statements
          );
        } catch (error) {
          console.error(
            "Hold transaction error:",
            error
          );

          /*
           * 同じIdempotency-Keyの
           * 同時POSTだった可能性を確認
           */
          const afterErrorBooking =
            await getBookingByIdempotencyKey(
              env,
              idempotencyKey
            );

          if (afterErrorBooking) {
            if (
              afterErrorBooking
                .idempotency_fingerprint
              !== fingerprint
            ) {
              return jsonError(
                "idempotency_key_conflict",
                409
              );
            }

            return existingBookingResponse(
              afterErrorBooking,
              true
            );
          }

          const message =
            String(
              error?.message || ""
            );

          /*
           * 別のお客様に
           * 在庫を先に取られた
           */
          if (
            message.includes(
              "UNIQUE constraint failed"
            ) ||
            message.includes(
              "SQLITE_CONSTRAINT"
            )
          ) {
            return jsonError(
              "inventory_changed",
              409
            );
          }

          throw error;
        }

        /*
         * 新規仮予約成功
         */
        return withCors(
         Response.json(
          {
            ok: true,

            booking_id:
              bookingId,

            booking_code:
              publicBookingCode,

            status:
              "pending_payment",

            payment_status:
              "unpaid",

            product_id,

            product_name:
              availability.product
                .name,

            check_in,
            check_out,

            nights:
              availability.nights,

            guest_count:
              parsedGuestCount,

            currency:
              availability.product
                .currency,

            total_price_jpy:
              availability.totalPrice,

            hold_expires_at:
              expiresAt,

            hold_minutes:
              HOLD_MINUTES,

            idempotency_replayed:
              false,
              },
              { status: 201 }
           ),
          request
        );
      } catch (error) {
        console.error(
          "Hold API error:",
          error
        );

        return jsonError(
          "internal_server_error",
          500
        );
      }
    }

/*
 * 管理者用：予約一覧
 */
if (
  url.pathname === "/api/admin/bookings" &&
  request.method === "GET"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const result = await env.DB
      .prepare(`
        SELECT
          b.id,
          b.public_booking_code,
          b.product_id,
          b.check_in_date,
          b.check_out_date,
          CAST(
            julianday(b.check_out_date) -
            julianday(b.check_in_date)
            AS INTEGER
          ) AS nights,
          b.guest_count,
          b.customer_name,
          b.customer_email,
          b.customer_phone,
          b.total_jpy,
          b.status,
          b.payment_status,
          b.confirmed_at,
          b.hold_expires_at,
          b.created_at,
          b.updated_at,

          (
            SELECT GROUP_CONCAT(
              DISTINCT i.allocation_type
            )
            FROM inventory_nights i
            WHERE i.allocation_ref = b.id
          ) AS inventory_type

        FROM bookings b
        ORDER BY datetime(b.created_at) DESC
        LIMIT 100
      `)
      .all();

    return withCors(
      Response.json({
        ok: true,
        bookings: result.results,
      }),
      request
    );
  } catch (error) {
    console.error(
      "Admin bookings API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error: "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}    

/*
 * 管理者用：キャンセル・返金額プレビュー
 * このAPIではまだStripe返金を実行しない。
 */
if (
  url.pathname ===
    "/api/admin/cancellation-preview" &&
  request.method === "POST"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const body = await request.json();

    const bookingCode =
      body.booking_code;

    const reasonCode =
      body.reason_code;

    const allowedReasons = new Set([
      "guest_request",
      "transport_cancellation",
      "facility_reason",
      "other",
    ]);

    if (
      !bookingCode ||
      !allowedReasons.has(reasonCode)
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "invalid_request",
          },
          { status: 400 }
        ),
        request
      );
    }

    const booking = await env.DB
      .prepare(`
        SELECT
          id,
          public_booking_code,
          check_in_date,
          check_out_date,
          guest_count,
          total_jpy,
          status,
          payment_status,
          customer_name
        FROM bookings
        WHERE public_booking_code = ?
        LIMIT 1
      `)
      .bind(bookingCode)
      .first();

    if (!booking) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_found",
          },
          { status: 404 }
        ),
        request
      );
    }

    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "paid"
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "booking_not_cancellable",
            booking_status:
              booking.status,
            payment_status:
              booking.payment_status,
          },
          { status: 409 }
        ),
        request
      );
    }

    const policyRate =
      getCancellationPolicyRate(
        booking.check_in_date,
        reasonCode
      );

    const cancellationFeeJpy =
      Math.floor(
        booking.total_jpy *
          (policyRate / 100)
      );

    const refundAmountJpy =
      booking.total_jpy -
      cancellationFeeJpy;

    const today = getTokyoToday();

    const toUtc = (dateString) => {
      const [year, month, day] =
        dateString.split("-").map(Number);

      return Date.UTC(
        year,
        month - 1,
        day
      );
    };

    const daysUntilCheckIn =
      Math.floor(
        (
          toUtc(booking.check_in_date) -
          toUtc(today)
        ) /
          86400000
      );

    return withCors(
      Response.json({
        ok: true,

        booking: {
          booking_code:
            booking.public_booking_code,

          customer_name:
            booking.customer_name,

          check_in:
            booking.check_in_date,

          check_out:
            booking.check_out_date,

          guest_count:
            booking.guest_count,

          total_jpy:
            booking.total_jpy,
        },

        cancellation: {
          reason_code:
            reasonCode,

          days_until_check_in:
            daysUntilCheckIn,

          policy_rate:
            policyRate,

          cancellation_fee_jpy:
            cancellationFeeJpy,

          refund_amount_jpy:
            refundAmountJpy,
        },
      }),
      request
    );
  } catch (error) {
    console.error(
      "Cancellation preview API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error: "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}

/*
 * 管理者用：予約キャンセル・Stripe返金実行
 */
if (
  url.pathname === "/api/admin/cancel-refund" &&
  request.method === "POST"
) {
  const authorization =
    request.headers.get("Authorization");

  const expectedAuthorization =
    `Bearer ${env.ADMIN_DASHBOARD_TOKEN}`;

  if (
    !env.ADMIN_DASHBOARD_TOKEN ||
    authorization !== expectedAuthorization
  ) {
    return withCors(
      Response.json(
        {
          ok: false,
          error: "unauthorized",
        },
        { status: 401 }
      ),
      request
    );
  }

  try {
    const body = await request.json();

    const bookingCode =
      body.booking_code;

    const reasonCode =
      body.reason_code;

    const adminNote =
      typeof body.admin_note === "string"
        ? body.admin_note.trim()
        : null;

    /*
     * 誤操作防止。
     * confirm:true がない限り実行しない。
     */
    if (body.confirm !== true) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "confirmation_required",
          },
          { status: 400 }
        ),
        request
      );
    }

    const allowedReasons = new Set([
      "guest_request",
      "transport_cancellation",
      "facility_reason",
      "other",
    ]);

    if (
      !bookingCode ||
      !allowedReasons.has(reasonCode)
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "invalid_request",
          },
          { status: 400 }
        ),
        request
      );
    }

    const booking = await env.DB
      .prepare(`
        SELECT
          id,
          public_booking_code,
          check_in_date,
          check_out_date,
          guest_count,
          total_jpy,
          status,
          payment_status,
          customer_name,
          customer_email,
          stripe_payment_intent_id
        FROM bookings
        WHERE public_booking_code = ?
        LIMIT 1
      `)
      .bind(bookingCode)
      .first();

    if (!booking) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_found",
          },
          { status: 404 }
        ),
        request
      );
    }

    /*
     * 二重キャンセル防止
     */
    const existingCancellation =
      await env.DB
        .prepare(`
          SELECT
            id,
            reason_code,
            refund_amount_jpy,
            stripe_refund_id,
            stripe_refund_status
          FROM booking_cancellations
          WHERE booking_id = ?
          LIMIT 1
        `)
        .bind(booking.id)
        .first();

    if (
      existingCancellation &&
      (
        existingCancellation
          .stripe_refund_status ===
            "succeeded" ||
        existingCancellation
          .stripe_refund_status ===
            "not_required"
      )
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "already_cancelled",
          },
          { status: 409 }
        ),
        request
      );
    }

    if (
      booking.status !== "confirmed" ||
      booking.payment_status !== "paid"
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error: "booking_not_cancellable",
            booking_status:
              booking.status,
            payment_status:
              booking.payment_status,
          },
          { status: 409 }
        ),
        request
      );
    }

    if (
      !booking.stripe_payment_intent_id
    ) {
      return withCors(
        Response.json(
          {
            ok: false,
            error:
              "stripe_payment_intent_missing",
          },
          { status: 409 }
        ),
        request
      );
    }

    /*
     * 金額はブラウザから受け取らず、
     * サーバー側で再計算する。
     */
    const policyRate =
      getCancellationPolicyRate(
        booking.check_in_date,
        reasonCode
      );

    const cancellationFeeJpy =
      Math.floor(
        booking.total_jpy *
          (policyRate / 100)
      );

    const refundAmountJpy =
      booking.total_jpy -
      cancellationFeeJpy;

    const cancellationId =
      existingCancellation?.id ??
      crypto.randomUUID();

    /*
     * まずキャンセル処理を pending として記録。
     */
    await env.DB
      .prepare(`
        INSERT INTO booking_cancellations (
          id,
          booking_id,
          reason_code,
          policy_rate,
          cancellation_fee_jpy,
          refund_amount_jpy,
          stripe_refund_status,
          admin_note
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)

        ON CONFLICT(booking_id)
        DO UPDATE SET
          reason_code = excluded.reason_code,
          policy_rate = excluded.policy_rate,
          cancellation_fee_jpy =
            excluded.cancellation_fee_jpy,
          refund_amount_jpy =
            excluded.refund_amount_jpy,
          stripe_refund_status =
            excluded.stripe_refund_status,
          admin_note = excluded.admin_note,
          updated_at = CURRENT_TIMESTAMP
      `)
      .bind(
        cancellationId,
        booking.id,
        reasonCode,
        policyRate,
        cancellationFeeJpy,
        refundAmountJpy,
        refundAmountJpy > 0
          ? "pending"
          : "not_required",
        adminNote
      )
      .run();

    let stripeRefundId = null;
    let stripeRefundStatus =
      refundAmountJpy > 0
        ? "pending"
        : "not_required";

    /*
     * 返金額が0円ならStripeには送らない。
     */
    if (refundAmountJpy > 0) {
      const stripeBody =
        new URLSearchParams();

      stripeBody.set(
        "payment_intent",
        booking.stripe_payment_intent_id
      );

      /*
       * JPYはゼロ小数通貨なので
       * ¥50,000 = amount 50000
       */
      stripeBody.set(
        "amount",
        String(refundAmountJpy)
      );

      const stripeResponse =
        await fetch(
          "https://api.stripe.com/v1/refunds",
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${env.STRIPE_SECRET_KEY}`,

              "Content-Type":
                "application/x-www-form-urlencoded",

              /*
               * 再送されても二重返金しない。
               */
              "Idempotency-Key":
                `booking-cancel-${booking.id}`,
            },

            body:
              stripeBody.toString(),
          }
        );

      const stripeRefund =
        await stripeResponse.json();

      if (!stripeResponse.ok) {
        console.error(
          "Stripe refund failed:",
          stripeRefund
        );

        await env.DB
          .prepare(`
            UPDATE booking_cancellations
            SET
              stripe_refund_status = 'failed',
              updated_at = CURRENT_TIMESTAMP
            WHERE booking_id = ?
          `)
          .bind(booking.id)
          .run();

        return withCors(
          Response.json(
            {
              ok: false,
              error: "stripe_refund_failed",
            },
            { status: 502 }
          ),
          request
        );
      }

      stripeRefundId =
        stripeRefund.id;

      stripeRefundStatus =
        stripeRefund.status === "succeeded"
          ? "succeeded"
          : "pending";
    }

    /*
     * payment_status
     *
     * 全額返金 → refunded
     * 一部返金 → partially_refunded
     * 返金なし → paidのまま
     * Stripe処理中 → paidのまま
     */
    let nextPaymentStatus =
      booking.payment_status;

    if (
      stripeRefundStatus === "succeeded"
    ) {
      nextPaymentStatus =
        refundAmountJpy ===
          booking.total_jpy
          ? "refunded"
          : "partially_refunded";
    }

    /*
     * 予約キャンセル・在庫解放・履歴確定
     */
    await env.DB.batch([
      env.DB
        .prepare(`
          UPDATE bookings
          SET
            status = 'cancelled',
            payment_status = ?,
            cancelled_at =
              CURRENT_TIMESTAMP,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(
          nextPaymentStatus,
          booking.id
        ),

      env.DB
        .prepare(`
          DELETE FROM inventory_nights
          WHERE allocation_ref = ?
        `)
        .bind(booking.id),

      env.DB
        .prepare(`
          UPDATE booking_cancellations
          SET
            stripe_refund_id = ?,
            stripe_refund_status = ?,
            updated_at =
              CURRENT_TIMESTAMP
          WHERE booking_id = ?
        `)
        .bind(
          stripeRefundId,
          stripeRefundStatus,
          booking.id
        ),
    ]);

    /*
     * お客様へキャンセル・返金完了メール。
     *
     * 送信失敗でも、すでに完了した
     * Stripe返金・予約キャンセル・在庫解放は
     * 取り消さない。
     */
    let cancellationEmailStatus =
      "skipped";

    try {
      cancellationEmailStatus =
        await sendCancellationCompletionEmail(
          env,
          booking.id
        );
    } catch (emailError) {
      cancellationEmailStatus =
        "failed";

      console.error(
        "Cancellation completion email error:",
        emailError
      );
    }

    return withCors(
      Response.json({
        ok: true,

        booking_code:
          booking.public_booking_code,

        status:
          "cancelled",

        payment_status:
          nextPaymentStatus,

        cancellation: {
          reason_code:
            reasonCode,

          policy_rate:
            policyRate,

          cancellation_fee_jpy:
            cancellationFeeJpy,

          refund_amount_jpy:
            refundAmountJpy,
        },

        stripe: {
          refund_id:
            stripeRefundId,

          refund_status:
            stripeRefundStatus,
        },

        cancellation_email:
          cancellationEmailStatus,
      }),
      request
    );
  } catch (error) {
    console.error(
      "Cancel refund API error:",
      error
    );

    return withCors(
      Response.json(
        {
          ok: false,
          error:
            "internal_server_error",
        },
        { status: 500 }
      ),
      request
    );
  }
}

    return jsonError(
      "not_found",
      404
    );
    },

  /*
   * 期限切れ仮予約の自動失効処理
   *
   * Cron Triggerから定期実行する。
   * 仮押さえ期限を5分以上過ぎても
   * 未決済の予約を expired にし、
   * 対応する hold 在庫を開放する。
   */
  async scheduled(event, env, ctx) {
    try {
      const results =
        await env.DB.batch([
          /*
           * 期限切れ予約
           *
           * pending_payment / unpaid のまま
           * hold期限を5分以上超過した予約だけ
           * expired に変更
           */
          env.DB.prepare(`
            UPDATE bookings
            SET
              status = 'expired',
              updated_at = CURRENT_TIMESTAMP
            WHERE status = 'pending_payment'
              AND payment_status = 'unpaid'
              AND hold_expires_at IS NOT NULL
              AND datetime(hold_expires_at)
                <= datetime('now', '-5 minutes')
          `),

          /*
           * expired になった予約の
           * 仮押さえ在庫を開放
           *
           * confirmed の予約は絶対に対象にしない
           */
          env.DB.prepare(`
            DELETE FROM inventory_nights
            WHERE allocation_type = 'hold'
              AND EXISTS (
                SELECT 1
                FROM bookings b
                WHERE b.id =
                  inventory_nights.allocation_ref
                  AND b.status = 'expired'
              )
          `),
        ]);

      const expiredBookings =
        results[0]?.meta?.changes || 0;

      const releasedHolds =
        results[1]?.meta?.changes || 0;

      console.log(
        "Expired booking cleanup completed:",
        {
          expired_bookings:
            expiredBookings,
          released_holds:
            releasedHolds,
        }
      );
    } catch (error) {
      console.error(
        "Expired booking cleanup error:",
        error
      );

      /*
       * Cron処理なので、
       * 予約APIそのものには影響させない。
       * 次回Cronで再試行される。
       */
    }
  },
};