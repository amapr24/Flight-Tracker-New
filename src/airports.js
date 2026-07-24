/**
 * A curated set of major airports for the picker's autocomplete.
 *
 * This is deliberately not an exhaustive IATA table — it exists to make the
 * common case fast to type, not to be authoritative. Any valid 3-letter code
 * can still be entered by hand, and the composer's live preview confirms the
 * route against Google before a watch is ever saved, so an airport missing
 * from this list costs nothing.
 *
 * Record format: CODE|City|Country|Airport name
 */

const DATA = `
ATL|Atlanta, GA|USA|Hartsfield–Jackson
LAX|Los Angeles, CA|USA|Los Angeles Intl
ORD|Chicago, IL|USA|O'Hare Intl
DFW|Dallas, TX|USA|Dallas/Fort Worth Intl
DEN|Denver, CO|USA|Denver Intl
JFK|New York, NY|USA|John F. Kennedy Intl
LGA|New York, NY|USA|LaGuardia
EWR|Newark, NJ|USA|Newark Liberty Intl
SFO|San Francisco, CA|USA|San Francisco Intl
SEA|Seattle, WA|USA|Seattle–Tacoma Intl
LAS|Las Vegas, NV|USA|Harry Reid Intl
MCO|Orlando, FL|USA|Orlando Intl
MIA|Miami, FL|USA|Miami Intl
CLT|Charlotte, NC|USA|Charlotte Douglas Intl
PHX|Phoenix, AZ|USA|Sky Harbor Intl
IAH|Houston, TX|USA|George Bush Intercontinental
HOU|Houston, TX|USA|William P. Hobby
BOS|Boston, MA|USA|Logan Intl
MSP|Minneapolis, MN|USA|Minneapolis–St Paul Intl
DTW|Detroit, MI|USA|Detroit Metropolitan
PHL|Philadelphia, PA|USA|Philadelphia Intl
FLL|Fort Lauderdale, FL|USA|Fort Lauderdale–Hollywood Intl
BWI|Baltimore, MD|USA|Baltimore/Washington Intl
DCA|Washington, DC|USA|Ronald Reagan National
IAD|Washington, DC|USA|Dulles Intl
SLC|Salt Lake City, UT|USA|Salt Lake City Intl
SAN|San Diego, CA|USA|San Diego Intl
TPA|Tampa, FL|USA|Tampa Intl
PDX|Portland, OR|USA|Portland Intl
STL|St. Louis, MO|USA|Lambert Intl
BNA|Nashville, TN|USA|Nashville Intl
AUS|Austin, TX|USA|Austin–Bergstrom Intl
MCI|Kansas City, MO|USA|Kansas City Intl
RDU|Raleigh, NC|USA|Raleigh–Durham Intl
SMF|Sacramento, CA|USA|Sacramento Intl
SJC|San Jose, CA|USA|Mineta San Jose Intl
MSY|New Orleans, LA|USA|Louis Armstrong Intl
CLE|Cleveland, OH|USA|Hopkins Intl
PIT|Pittsburgh, PA|USA|Pittsburgh Intl
CVG|Cincinnati, OH|USA|Cincinnati/Northern Kentucky Intl
IND|Indianapolis, IN|USA|Indianapolis Intl
CMH|Columbus, OH|USA|John Glenn Columbus Intl
MKE|Milwaukee, WI|USA|Mitchell Intl
JAX|Jacksonville, FL|USA|Jacksonville Intl
RSW|Fort Myers, FL|USA|Southwest Florida Intl
PBI|West Palm Beach, FL|USA|Palm Beach Intl
OAK|Oakland, CA|USA|Oakland Intl
ONT|Ontario, CA|USA|Ontario Intl
SNA|Santa Ana, CA|USA|John Wayne
BUR|Burbank, CA|USA|Hollywood Burbank
HNL|Honolulu, HI|USA|Daniel K. Inouye Intl
OGG|Maui, HI|USA|Kahului
KOA|Kona, HI|USA|Ellison Onizuka Kona Intl
LIH|Kauai, HI|USA|Lihue
ANC|Anchorage, AK|USA|Ted Stevens Intl
FAI|Fairbanks, AK|USA|Fairbanks Intl
ABQ|Albuquerque, NM|USA|Albuquerque Intl Sunport
TUS|Tucson, AZ|USA|Tucson Intl
OKC|Oklahoma City, OK|USA|Will Rogers World
TUL|Tulsa, OK|USA|Tulsa Intl
OMA|Omaha, NE|USA|Eppley Airfield
DSM|Des Moines, IA|USA|Des Moines Intl
BOI|Boise, ID|USA|Boise Airport
RNO|Reno, NV|USA|Reno–Tahoe Intl
ELP|El Paso, TX|USA|El Paso Intl
SAT|San Antonio, TX|USA|San Antonio Intl
MEM|Memphis, TN|USA|Memphis Intl
BHM|Birmingham, AL|USA|Birmingham–Shuttlesworth Intl
CHS|Charleston, SC|USA|Charleston Intl
SAV|Savannah, GA|USA|Savannah/Hilton Head Intl
GSP|Greenville, SC|USA|Greenville–Spartanburg Intl
ORF|Norfolk, VA|USA|Norfolk Intl
RIC|Richmond, VA|USA|Richmond Intl
ALB|Albany, NY|USA|Albany Intl
BUF|Buffalo, NY|USA|Buffalo Niagara Intl
ROC|Rochester, NY|USA|Greater Rochester Intl
SYR|Syracuse, NY|USA|Syracuse Hancock Intl
PVD|Providence, RI|USA|T.F. Green Intl
BDL|Hartford, CT|USA|Bradley Intl
MHT|Manchester, NH|USA|Manchester–Boston Regional
PWM|Portland, ME|USA|Portland Intl Jetport
BTV|Burlington, VT|USA|Burlington Intl
GRR|Grand Rapids, MI|USA|Gerald R. Ford Intl
MSN|Madison, WI|USA|Dane County Regional
DAY|Dayton, OH|USA|Dayton Intl
SDF|Louisville, KY|USA|Muhammad Ali Intl
LEX|Lexington, KY|USA|Blue Grass
LIT|Little Rock, AR|USA|Clinton National
GEG|Spokane, WA|USA|Spokane Intl
COS|Colorado Springs, CO|USA|Colorado Springs
SJU|San Juan|Puerto Rico|Luis Muñoz Marín Intl
BQN|Aguadilla|Puerto Rico|Rafael Hernández
PSE|Ponce|Puerto Rico|Mercedita
STT|St. Thomas|US Virgin Islands|Cyril E. King
STX|St. Croix|US Virgin Islands|Henry E. Rohlsen
SDQ|Santo Domingo|Dominican Republic|Las Américas Intl
PUJ|Punta Cana|Dominican Republic|Punta Cana Intl
STI|Santiago|Dominican Republic|Cibao Intl
POP|Puerto Plata|Dominican Republic|Gregorio Luperón Intl
HAV|Havana|Cuba|José Martí Intl
MBJ|Montego Bay|Jamaica|Sangster Intl
KIN|Kingston|Jamaica|Norman Manley Intl
NAS|Nassau|Bahamas|Lynden Pindling Intl
BGI|Bridgetown|Barbados|Grantley Adams Intl
AUA|Oranjestad|Aruba|Queen Beatrix Intl
CUR|Willemstad|Curaçao|Hato Intl
SXM|Philipsburg|Sint Maarten|Princess Juliana Intl
ANU|St. John's|Antigua|V.C. Bird Intl
SKB|Basseterre|St. Kitts|Robert L. Bradshaw Intl
UVF|Vieux Fort|St. Lucia|Hewanorra Intl
GND|St. George's|Grenada|Maurice Bishop Intl
POS|Port of Spain|Trinidad|Piarco Intl
PTP|Pointe-à-Pitre|Guadeloupe|Pôle Caraïbes
FDF|Fort-de-France|Martinique|Aimé Césaire Intl
CUN|Cancún|Mexico|Cancún Intl
MEX|Mexico City|Mexico|Benito Juárez Intl
GDL|Guadalajara|Mexico|Miguel Hidalgo Intl
MTY|Monterrey|Mexico|Mariano Escobedo Intl
SJD|Los Cabos|Mexico|Los Cabos Intl
PVR|Puerto Vallarta|Mexico|Lic. Gustavo Díaz Ordaz
TIJ|Tijuana|Mexico|Tijuana Intl
GUA|Guatemala City|Guatemala|La Aurora Intl
SAL|San Salvador|El Salvador|El Salvador Intl
SJO|San José|Costa Rica|Juan Santamaría Intl
LIR|Liberia|Costa Rica|Daniel Oduber Quirós Intl
PTY|Panama City|Panama|Tocumen Intl
BOG|Bogotá|Colombia|El Dorado Intl
MDE|Medellín|Colombia|José María Córdova Intl
CTG|Cartagena|Colombia|Rafael Núñez Intl
CLO|Cali|Colombia|Alfonso Bonilla Aragón Intl
UIO|Quito|Ecuador|Mariscal Sucre Intl
GYE|Guayaquil|Ecuador|José Joaquín de Olmedo Intl
LIM|Lima|Peru|Jorge Chávez Intl
CUZ|Cusco|Peru|Alejandro Velasco Astete Intl
LPB|La Paz|Bolivia|El Alto Intl
SCL|Santiago|Chile|Arturo Merino Benítez Intl
EZE|Buenos Aires|Argentina|Ministro Pistarini (Ezeiza)
AEP|Buenos Aires|Argentina|Jorge Newbery Aeroparque
MVD|Montevideo|Uruguay|Carrasco Intl
ASU|Asunción|Paraguay|Silvio Pettirossi Intl
GRU|São Paulo|Brazil|Guarulhos Intl
CGH|São Paulo|Brazil|Congonhas
GIG|Rio de Janeiro|Brazil|Galeão Intl
SDU|Rio de Janeiro|Brazil|Santos Dumont
BSB|Brasília|Brazil|Presidente Juscelino Kubitschek
CNF|Belo Horizonte|Brazil|Tancredo Neves Intl
SSA|Salvador|Brazil|Deputado Luís Eduardo Magalhães
REC|Recife|Brazil|Guararapes Intl
FOR|Fortaleza|Brazil|Pinto Martins Intl
MAO|Manaus|Brazil|Eduardo Gomes Intl
CCS|Caracas|Venezuela|Simón Bolívar Intl
YYZ|Toronto|Canada|Pearson Intl
YVR|Vancouver|Canada|Vancouver Intl
YUL|Montréal|Canada|Pierre Elliott Trudeau Intl
YYC|Calgary|Canada|Calgary Intl
YEG|Edmonton|Canada|Edmonton Intl
YOW|Ottawa|Canada|Macdonald–Cartier Intl
YHZ|Halifax|Canada|Stanfield Intl
YWG|Winnipeg|Canada|Richardson Intl
YQB|Québec City|Canada|Jean Lesage Intl
YXE|Saskatoon|Canada|Diefenbaker Intl
YYT|St. John's|Canada|St. John's Intl
LHR|London|United Kingdom|Heathrow
LGW|London|United Kingdom|Gatwick
STN|London|United Kingdom|Stansted
LTN|London|United Kingdom|Luton
LCY|London|United Kingdom|London City
MAN|Manchester|United Kingdom|Manchester
BHX|Birmingham|United Kingdom|Birmingham
EDI|Edinburgh|United Kingdom|Edinburgh
GLA|Glasgow|United Kingdom|Glasgow
BRS|Bristol|United Kingdom|Bristol
NCL|Newcastle|United Kingdom|Newcastle
LPL|Liverpool|United Kingdom|John Lennon
DUB|Dublin|Ireland|Dublin
SNN|Shannon|Ireland|Shannon
CDG|Paris|France|Charles de Gaulle
ORY|Paris|France|Orly
NCE|Nice|France|Côte d'Azur
LYS|Lyon|France|Saint-Exupéry
MRS|Marseille|France|Provence
TLS|Toulouse|France|Blagnac
BOD|Bordeaux|France|Mérignac
AMS|Amsterdam|Netherlands|Schiphol
BRU|Brussels|Belgium|Brussels
FRA|Frankfurt|Germany|Frankfurt
MUC|Munich|Germany|Munich
BER|Berlin|Germany|Brandenburg
DUS|Düsseldorf|Germany|Düsseldorf
HAM|Hamburg|Germany|Hamburg
CGN|Cologne|Germany|Cologne Bonn
STR|Stuttgart|Germany|Stuttgart
MAD|Madrid|Spain|Adolfo Suárez Barajas
BCN|Barcelona|Spain|El Prat
AGP|Málaga|Spain|Costa del Sol
PMI|Palma de Mallorca|Spain|Son Sant Joan
VLC|Valencia|Spain|Valencia
SVQ|Seville|Spain|Seville
BIO|Bilbao|Spain|Bilbao
ALC|Alicante|Spain|Alicante–Elche
LPA|Las Palmas|Spain|Gran Canaria
TFS|Tenerife|Spain|Tenerife South
LIS|Lisbon|Portugal|Humberto Delgado
OPO|Porto|Portugal|Francisco Sá Carneiro
FAO|Faro|Portugal|Faro
FCO|Rome|Italy|Fiumicino
MXP|Milan|Italy|Malpensa
LIN|Milan|Italy|Linate
BGY|Milan|Italy|Bergamo Orio al Serio
VCE|Venice|Italy|Marco Polo
NAP|Naples|Italy|Capodichino
BLQ|Bologna|Italy|Guglielmo Marconi
FLR|Florence|Italy|Peretola
CTA|Catania|Italy|Fontanarossa
PMO|Palermo|Italy|Falcone Borsellino
ZRH|Zurich|Switzerland|Zurich
GVA|Geneva|Switzerland|Geneva
BSL|Basel|Switzerland|EuroAirport
VIE|Vienna|Austria|Vienna Intl
CPH|Copenhagen|Denmark|Kastrup
ARN|Stockholm|Sweden|Arlanda
OSL|Oslo|Norway|Gardermoen
HEL|Helsinki|Finland|Vantaa
KEF|Reykjavík|Iceland|Keflavík
PRG|Prague|Czechia|Václav Havel
WAW|Warsaw|Poland|Chopin
KRK|Kraków|Poland|John Paul II
GDN|Gdańsk|Poland|Lech Wałęsa
BUD|Budapest|Hungary|Ferenc Liszt Intl
OTP|Bucharest|Romania|Henri Coandă Intl
SOF|Sofia|Bulgaria|Sofia
BEG|Belgrade|Serbia|Nikola Tesla
ZAG|Zagreb|Croatia|Franjo Tuđman
SPU|Split|Croatia|Split
DBV|Dubrovnik|Croatia|Dubrovnik
LJU|Ljubljana|Slovenia|Jože Pučnik
ATH|Athens|Greece|Eleftherios Venizelos
SKG|Thessaloniki|Greece|Macedonia
HER|Heraklion|Greece|Nikos Kazantzakis
RHO|Rhodes|Greece|Diagoras
JMK|Mykonos|Greece|Mykonos
JTR|Santorini|Greece|Santorini
IST|Istanbul|Türkiye|Istanbul
SAW|Istanbul|Türkiye|Sabiha Gökçen
AYT|Antalya|Türkiye|Antalya
ESB|Ankara|Türkiye|Esenboğa
RIX|Riga|Latvia|Riga Intl
TLL|Tallinn|Estonia|Lennart Meri
VNO|Vilnius|Lithuania|Vilnius
LUX|Luxembourg|Luxembourg|Findel
MLA|Valletta|Malta|Malta Intl
LCA|Larnaca|Cyprus|Larnaca Intl
TIA|Tirana|Albania|Mother Teresa
SVO|Moscow|Russia|Sheremetyevo
DME|Moscow|Russia|Domodedovo
LED|St. Petersburg|Russia|Pulkovo
DXB|Dubai|UAE|Dubai Intl
AUH|Abu Dhabi|UAE|Zayed Intl
DOH|Doha|Qatar|Hamad Intl
KWI|Kuwait City|Kuwait|Kuwait Intl
BAH|Manama|Bahrain|Bahrain Intl
RUH|Riyadh|Saudi Arabia|King Khalid Intl
JED|Jeddah|Saudi Arabia|King Abdulaziz Intl
MCT|Muscat|Oman|Muscat Intl
AMM|Amman|Jordan|Queen Alia Intl
BEY|Beirut|Lebanon|Rafic Hariri Intl
TLV|Tel Aviv|Israel|Ben Gurion
CAI|Cairo|Egypt|Cairo Intl
HRG|Hurghada|Egypt|Hurghada Intl
SSH|Sharm El Sheikh|Egypt|Sharm El Sheikh Intl
CMN|Casablanca|Morocco|Mohammed V Intl
RAK|Marrakesh|Morocco|Menara
TUN|Tunis|Tunisia|Carthage
ALG|Algiers|Algeria|Houari Boumediene
LOS|Lagos|Nigeria|Murtala Muhammed Intl
ABV|Abuja|Nigeria|Nnamdi Azikiwe Intl
ACC|Accra|Ghana|Kotoka Intl
NBO|Nairobi|Kenya|Jomo Kenyatta Intl
ADD|Addis Ababa|Ethiopia|Bole Intl
DAR|Dar es Salaam|Tanzania|Julius Nyerere Intl
JRO|Kilimanjaro|Tanzania|Kilimanjaro Intl
ZNZ|Zanzibar|Tanzania|Abeid Amani Karume Intl
JNB|Johannesburg|South Africa|O.R. Tambo Intl
CPT|Cape Town|South Africa|Cape Town Intl
DUR|Durban|South Africa|King Shaka Intl
MRU|Port Louis|Mauritius|Sir Seewoosagur Ramgoolam Intl
SEZ|Mahé|Seychelles|Seychelles Intl
RUN|Saint-Denis|Réunion|Roland Garros
NRT|Tokyo|Japan|Narita Intl
HND|Tokyo|Japan|Haneda
KIX|Osaka|Japan|Kansai Intl
ITM|Osaka|Japan|Itami
NGO|Nagoya|Japan|Chubu Centrair Intl
CTS|Sapporo|Japan|New Chitose
FUK|Fukuoka|Japan|Fukuoka
OKA|Okinawa|Japan|Naha
ICN|Seoul|South Korea|Incheon Intl
GMP|Seoul|South Korea|Gimpo Intl
PUS|Busan|South Korea|Gimhae Intl
PEK|Beijing|China|Capital Intl
PKX|Beijing|China|Daxing Intl
PVG|Shanghai|China|Pudong Intl
SHA|Shanghai|China|Hongqiao Intl
CAN|Guangzhou|China|Baiyun Intl
SZX|Shenzhen|China|Bao'an Intl
CTU|Chengdu|China|Tianfu Intl
XIY|Xi'an|China|Xianyang Intl
HGH|Hangzhou|China|Xiaoshan Intl
HKG|Hong Kong|Hong Kong|Hong Kong Intl
MFM|Macau|Macau|Macau Intl
TPE|Taipei|Taiwan|Taoyuan Intl
TSA|Taipei|Taiwan|Songshan
SIN|Singapore|Singapore|Changi
KUL|Kuala Lumpur|Malaysia|Kuala Lumpur Intl
PEN|Penang|Malaysia|Penang Intl
BKK|Bangkok|Thailand|Suvarnabhumi
DMK|Bangkok|Thailand|Don Mueang
HKT|Phuket|Thailand|Phuket Intl
CNX|Chiang Mai|Thailand|Chiang Mai Intl
CGK|Jakarta|Indonesia|Soekarno–Hatta Intl
DPS|Bali|Indonesia|Ngurah Rai Intl
SUB|Surabaya|Indonesia|Juanda Intl
MNL|Manila|Philippines|Ninoy Aquino Intl
CEB|Cebu|Philippines|Mactan–Cebu Intl
SGN|Ho Chi Minh City|Vietnam|Tan Son Nhat Intl
HAN|Hanoi|Vietnam|Noi Bai Intl
DAD|Da Nang|Vietnam|Da Nang Intl
PNH|Phnom Penh|Cambodia|Phnom Penh Intl
REP|Siem Reap|Cambodia|Angkor Intl
RGN|Yangon|Myanmar|Yangon Intl
VTE|Vientiane|Laos|Wattay Intl
DEL|Delhi|India|Indira Gandhi Intl
BOM|Mumbai|India|Chhatrapati Shivaji Intl
BLR|Bengaluru|India|Kempegowda Intl
MAA|Chennai|India|Chennai Intl
HYD|Hyderabad|India|Rajiv Gandhi Intl
CCU|Kolkata|India|Netaji Subhas Chandra Bose Intl
COK|Kochi|India|Cochin Intl
AMD|Ahmedabad|India|Sardar Vallabhbhai Patel Intl
GOI|Goa|India|Dabolim
TRV|Thiruvananthapuram|India|Trivandrum Intl
CMB|Colombo|Sri Lanka|Bandaranaike Intl
MLE|Malé|Maldives|Velana Intl
KTM|Kathmandu|Nepal|Tribhuvan Intl
DAC|Dhaka|Bangladesh|Hazrat Shahjalal Intl
KHI|Karachi|Pakistan|Jinnah Intl
LHE|Lahore|Pakistan|Allama Iqbal Intl
ISB|Islamabad|Pakistan|Islamabad Intl
TAS|Tashkent|Uzbekistan|Islam Karimov Intl
ALA|Almaty|Kazakhstan|Almaty Intl
GYD|Baku|Azerbaijan|Heydar Aliyev Intl
TBS|Tbilisi|Georgia|Tbilisi Intl
EVN|Yerevan|Armenia|Zvartnots Intl
SYD|Sydney|Australia|Kingsford Smith
MEL|Melbourne|Australia|Tullamarine
BNE|Brisbane|Australia|Brisbane
PER|Perth|Australia|Perth
ADL|Adelaide|Australia|Adelaide
OOL|Gold Coast|Australia|Gold Coast
CNS|Cairns|Australia|Cairns
CBR|Canberra|Australia|Canberra
HBA|Hobart|Australia|Hobart
DRW|Darwin|Australia|Darwin
AKL|Auckland|New Zealand|Auckland
CHC|Christchurch|New Zealand|Christchurch
WLG|Wellington|New Zealand|Wellington
ZQN|Queenstown|New Zealand|Queenstown
NAN|Nadi|Fiji|Nadi Intl
PPT|Papeete|French Polynesia|Faa'a Intl
GUM|Hagåtña|Guam|Antonio B. Won Pat Intl
NOU|Nouméa|New Caledonia|La Tontouta Intl
`;

export const AIRPORTS = DATA.trim()
  .split('\n')
  .map((line) => {
    const [code, city, country, name] = line.split('|');
    return { code, city, country, name };
  });

const BY_CODE = new Map(AIRPORTS.map((a) => [a.code, a]));

export const lookup = (code) => BY_CODE.get(String(code).toUpperCase()) ?? null;

/** Formats an airport for display, falling back gracefully for unknown codes. */
export function describe(code) {
  const a = lookup(code);
  return a ? `${a.city}, ${a.country}` : code;
}

const normalise = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fold accents so "Malaga" finds "Málaga"
    .toLowerCase();

/**
 * Ranked substring search over code, city, country and airport name.
 * An exact code match always sorts first so typing "LAX" never buries LAX.
 */
export function search(query, limit = 8) {
  const q = normalise(String(query ?? '').trim());
  if (!q) return [];

  const scored = [];
  for (const a of AIRPORTS) {
    const code = normalise(a.code);
    const city = normalise(a.city);
    const country = normalise(a.country);
    const name = normalise(a.name);

    let score = null;
    if (code === q) score = 0;
    else if (city.startsWith(q)) score = 1;
    else if (code.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (city.includes(q)) score = 4;
    else if (name.includes(q)) score = 5;
    else if (country.includes(q)) score = 6;

    if (score !== null) scored.push({ score, airport: a });
  }

  return scored
    .sort((x, y) => x.score - y.score || x.airport.city.localeCompare(y.airport.city))
    .slice(0, limit)
    .map((s) => s.airport);
}
