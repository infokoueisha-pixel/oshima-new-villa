export const SITE = {
  url: 'https://oshima-new-villa.com/',
  name: '大島ニュービラ',
  alternateName: 'Oshima New Villa',
  description: '東京都・伊豆大島の元町にある一棟貸しの宿。SALVIA（最大6名）とFREESIA（最大3名）の2棟から選べ、2棟利用時は最大9名まで宿泊できます。1975年開業、2026年リニューアル。',
  foundingDate: '1975',
  reopenedYear: 2026,
  address: {
    postalCode: '100-0101',
    addressRegion: '東京都',
    addressLocality: '大島町',
    streetAddress: '元町字新込126-42',
    addressCountry: 'JP',
  },
  checkinTime: '15:00',
  checkoutTime: '10:00',
  maxGuests: 9,
  publicRoomName: 'SALVIA / FREESIA',
  instagram: 'https://www.instagram.com/oshima.new.villa/',
  airbnbJa: 'https://www.airbnb.jp/rooms/1602063410123886296',
  airbnbIntl: 'https://www.airbnb.com/rooms/1602063410123886296',
  bookingUrl: 'https://www.booking.com/hotel/jp/salvia.ja.html',
  lastReviewed: '2026-09-22',
} as const;

export const AMENITIES = [
  '一棟貸切',
  '2棟利用で最大9名',
  '無料Wi-Fi',
  'キッチン',
  '屋外BBQ設備',
  '無料駐車場',
  'セルフチェックイン',
] as const;


export const VILLAS = [
  {
    id: 'salvia',
    name: 'SALVIA',
    nameJa: 'サルビア',
    bookingName: '1ベッドルーム ヴィラ',
    maxGuests: 6,
    floorSize: 69.27,
    beds: 'シングルベッド4台＋ソファベッド2台',
    image: '/day-salvia.webp',
    description: '家族・友人・グループ旅行に。リビング、キッチン、浴室、屋外BBQスペースを備えた最大6名の一棟貸し。',
  },
  {
    id: 'freesia',
    name: 'FREESIA',
    nameJa: 'フリージア',
    bookingName: 'ヴィラ',
    maxGuests: 3,
    floorSize: 30,
    beds: 'シングルベッド2台＋ソファベッド1台',
    image: '/freesia-exterior.webp',
    description: '夫婦・カップル・少人数旅行に。キッチン、浴室、トイレ、洗面、ウッドデッキを備えた最大3名のコンパクトヴィラ。',
  },
] as const;
