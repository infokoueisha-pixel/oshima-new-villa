export const SITE = {
  url: 'https://oshima-new-villa.com/',
  name: '大島ニュービラ',
  alternateName: 'Oshima New Villa',
  description: '東京都・伊豆大島の元町にある一棟貸しの宿。1975年開業、2026年リニューアル。家族・友人で最大6名、キッチン・BBQ・無料Wi-Fi・駐車場を備えています。',
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
  maxGuests: 6,
  publicRoomName: 'SALVIA',
  instagram: 'https://www.instagram.com/oshima.new.villa/',
  airbnbJa: 'https://www.airbnb.jp/rooms/1602063410123886296',
  airbnbIntl: 'https://www.airbnb.com/rooms/1602063410123886296',
  lastReviewed: '2026-09-09',
} as const;

export const AMENITIES = [
  '一棟貸切',
  '最大6名',
  '無料Wi-Fi',
  'キッチン',
  '屋外BBQ設備',
  '無料駐車場',
  'セルフチェックイン',
] as const;
