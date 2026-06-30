// National-team flags for soccer. The feed's World Cup / international fixtures
// use country names as team names ("Brazil", "England", "Korea Republic"), so
// we map those to ISO codes and serve a flag from flagcdn. Club teams won't
// match the country map and fall through to the normal logo resolution.

/** ISO 3166-1 alpha-2 (lowercase) flagcdn codes, keyed by a normalized name.
 *  UK home nations use flagcdn's gb-eng / gb-sct / gb-wls / gb-nir. */
const CODES: Record<string, string> = {
  afghanistan: 'af', albania: 'al', algeria: 'dz', andorra: 'ad', angola: 'ao',
  argentina: 'ar', armenia: 'am', aruba: 'aw', australia: 'au', austria: 'at',
  azerbaijan: 'az', bahrain: 'bh', bangladesh: 'bd', belarus: 'by', belgium: 'be',
  belize: 'bz', benin: 'bj', bermuda: 'bm', bolivia: 'bo', botswana: 'bw',
  bosniaherzegovina: 'ba', bosniaandherzegovina: 'ba', brazil: 'br', bulgaria: 'bg',
  burkinafaso: 'bf', burundi: 'bi', caboverde: 'cv', capeverde: 'cv', cameroon: 'cm',
  canada: 'ca', caymanislands: 'ky', centralafricanrepublic: 'cf', chad: 'td',
  chile: 'cl', china: 'cn', chinapr: 'cn', colombia: 'co', comoros: 'km',
  congo: 'cg', congodr: 'cd', drcongo: 'cd', costarica: 'cr', croatia: 'hr',
  cuba: 'cu', curacao: 'cw', cyprus: 'cy', czechia: 'cz', czechrepublic: 'cz',
  cotedivoire: 'ci', ivorycoast: 'ci', denmark: 'dk', djibouti: 'dj', dominica: 'dm',
  dominicanrepublic: 'do', ecuador: 'ec', egypt: 'eg', elsalvador: 'sv',
  england: 'gb-eng', equatorialguinea: 'gq', eritrea: 'er', estonia: 'ee',
  eswatini: 'sz', ethiopia: 'et', fiji: 'fj', finland: 'fi', france: 'fr',
  gabon: 'ga', gambia: 'gm', georgia: 'ge', germany: 'de', ghana: 'gh',
  gibraltar: 'gi', greece: 'gr', grenada: 'gd', guam: 'gu', guatemala: 'gt',
  guinea: 'gn', guineabissau: 'gw', guyana: 'gy', haiti: 'ht', honduras: 'hn',
  hongkong: 'hk', hongkongchina: 'hk', hungary: 'hu', iceland: 'is', india: 'in',
  indonesia: 'id', iran: 'ir', iriran: 'ir', iraq: 'iq', ireland: 'ie',
  republicofireland: 'ie', israel: 'il', italy: 'it', jamaica: 'jm', japan: 'jp',
  jordan: 'jo', kazakhstan: 'kz', kenya: 'ke', kosovo: 'xk', kuwait: 'kw',
  kyrgyzrepublic: 'kg', kyrgyzstan: 'kg', laos: 'la', latvia: 'lv', lebanon: 'lb',
  lesotho: 'ls', liberia: 'lr', libya: 'ly', liechtenstein: 'li', lithuania: 'lt',
  luxembourg: 'lu', madagascar: 'mg', malawi: 'mw', malaysia: 'my', maldives: 'mv',
  mali: 'ml', malta: 'mt', mauritania: 'mr', mauritius: 'mu', mexico: 'mx',
  moldova: 'md', mongolia: 'mn', montenegro: 'me', morocco: 'ma', mozambique: 'mz',
  myanmar: 'mm', namibia: 'na', nepal: 'np', netherlands: 'nl', newzealand: 'nz',
  nicaragua: 'ni', niger: 'ne', nigeria: 'ng', northkorea: 'kp', koreadpr: 'kp',
  northmacedonia: 'mk', northernireland: 'gb-nir', norway: 'no', oman: 'om',
  pakistan: 'pk', palestine: 'ps', panama: 'pa', papuanewguinea: 'pg', paraguay: 'py',
  peru: 'pe', philippines: 'ph', poland: 'pl', portugal: 'pt', puertorico: 'pr',
  qatar: 'qa', romania: 'ro', russia: 'ru', rwanda: 'rw', samoa: 'ws',
  sanmarino: 'sm', saudiarabia: 'sa', scotland: 'gb-sct', senegal: 'sn', serbia: 'rs',
  sierraleone: 'sl', singapore: 'sg', slovakia: 'sk', slovenia: 'si', somalia: 'so',
  southafrica: 'za', southkorea: 'kr', korearepublic: 'kr', southsudan: 'ss',
  spain: 'es', srilanka: 'lk', sudan: 'sd', suriname: 'sr', sweden: 'se',
  switzerland: 'ch', syria: 'sy', taiwan: 'tw', chinesetaipei: 'tw', tajikistan: 'tj',
  tanzania: 'tz', thailand: 'th', togo: 'tg', tonga: 'to', trinidadandtobago: 'tt',
  tunisia: 'tn', turkey: 'tr', turkiye: 'tr', turkmenistan: 'tm', uganda: 'ug',
  ukraine: 'ua', unitedarabemirates: 'ae', uae: 'ae', unitedstates: 'us', usa: 'us',
  uruguay: 'uy', uzbekistan: 'uz', vanuatu: 'vu', venezuela: 've', vietnam: 'vn',
  wales: 'gb-wls', yemen: 'ye', zambia: 'zm', zimbabwe: 'zw',
}

function normCountry(name: string): string {
  return (name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z]/g, '') // drop spaces/punctuation/digits
}

/** Flag URL for a national-team name, else null (clubs won't match). */
export function countryFlagUrl(name: string): string | null {
  const code = CODES[normCountry(name)]
  return code ? `https://flagcdn.com/w160/${code}.png` : null
}
