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

export { isValidDate, getStayDates, toSqlUtc, getTokyoToday, getCancellationPolicyRate };
