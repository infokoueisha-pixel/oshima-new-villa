import { HOLD_MINUTES } from "../config.js";
import { getStayDates } from "../lib/dates.js";

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

export { createPublicBookingCode, sha256, createFingerprint, getAvailability, getBookingByIdempotencyKey, existingBookingResponse };
