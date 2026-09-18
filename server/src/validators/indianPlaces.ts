/**
 * Indian place names, as single lowercase words, for the spell check (Master sheet item 13).
 *
 * Two jobs, both in spellValidator:
 *  1. A place spelled correctly is a real word. It is never flagged, and never "corrected"
 *     into a form word — before this list, "Pune" was reported as a misspelling of "june"
 *     and "Medchal" of "medical".
 *  2. A place spelled wrongly ("Bhopl", "1angalore" → "angalore") is a near-miss of one of
 *     these, reported DOUBTFUL for the reviewer. Never an outright failure: OCR mangles place
 *     names far more than form words, and a reader cannot tell a forged "Lucnow" from a
 *     correctly printed "Lucknow" the scanner misread.
 *
 * States and union territories, plus cities and district headquarters that appear in claim
 * addresses. Words under four letters are left out: the matcher ignores them anyway
 * (MIN_TERM_LEN). Names that are also ordinary English words ("mango", "sultan") are left
 * out too — they are real words already and would only add noise as near-miss targets.
 * ponytail: a curated list, not a gazetteer. A misspelled town that is not here is simply
 * not checked; add it to the list (or to the Spell Dictionary) when one shows up.
 */
export const INDIAN_PLACE_WORDS: string[] = [
  // States and union territories
  'andhra', 'pradesh', 'arunachal', 'assam', 'bihar', 'chhattisgarh', 'gujarat', 'haryana',
  'himachal', 'jharkhand', 'karnataka', 'kerala', 'madhya', 'maharashtra', 'manipur',
  'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan', 'sikkim',
  'tamil', 'nadu', 'telangana', 'tripura', 'uttar', 'uttarakhand', 'uttaranchal', 'bengal',
  'andaman', 'nicobar', 'chandigarh', 'dadra', 'nagar', 'haveli', 'daman', 'delhi', 'jammu',
  'kashmir', 'ladakh', 'lakshadweep', 'puducherry', 'pondicherry',
  // Metros and large cities
  'mumbai', 'bombay', 'bangalore', 'bengaluru', 'hyderabad', 'secunderabad', 'ahmedabad',
  'chennai', 'madras', 'kolkata', 'calcutta', 'surat', 'pune', 'jaipur', 'lucknow', 'kanpur',
  'nagpur', 'indore', 'thane', 'bhopal', 'visakhapatnam', 'vizag', 'pimpri', 'chinchwad',
  'patna', 'vadodara', 'baroda', 'ghaziabad', 'ludhiana', 'agra', 'nashik', 'faridabad',
  'meerut', 'rajkot', 'kalyan', 'dombivli', 'vasai', 'virar', 'varanasi', 'srinagar',
  'aurangabad', 'dhanbad', 'amritsar', 'navi', 'allahabad', 'prayagraj', 'ranchi', 'howrah',
  'coimbatore', 'jabalpur', 'gwalior', 'vijayawada', 'jodhpur', 'madurai', 'raipur', 'kota',
  'guwahati', 'solapur', 'hubli', 'dharwad', 'bareilly', 'moradabad', 'mysore', 'mysuru',
  'gurgaon', 'gurugram', 'aligarh', 'jalandhar', 'tiruchirappalli', 'trichy', 'bhubaneswar',
  'salem', 'warangal', 'guntur', 'bhiwandi', 'saharanpur', 'gorakhpur', 'bikaner', 'amravati',
  'noida', 'jamshedpur', 'bhilai', 'cuttack', 'firozabad', 'kochi', 'cochin', 'nellore',
  'bhavnagar', 'dehradun', 'durgapur', 'asansol', 'rourkela', 'nanded', 'kolhapur', 'ajmer',
  'akola', 'gulbarga', 'kalaburagi', 'jamnagar', 'ujjain', 'siliguri', 'jhansi',
  'ulhasnagar', 'sangli', 'miraj', 'mangalore', 'mangaluru', 'erode', 'belgaum', 'belagavi',
  'tirunelveli', 'malegaon', 'jalgaon', 'udaipur', 'davanagere', 'kozhikode', 'calicut',
  'kurnool', 'rajahmundry', 'bokaro', 'bellary', 'ballari', 'patiala', 'agartala',
  'bhagalpur', 'muzaffarnagar', 'latur', 'dhule', 'tirupati', 'rohtak', 'korba', 'bhilwara',
  'berhampur', 'muzaffarpur', 'ahmednagar', 'mathura', 'kollam', 'kadapa', 'sambalpur',
  'bilaspur', 'shahjahanpur', 'satara', 'bijapur', 'vijayapura', 'rampur', 'shimoga',
  'shivamogga', 'chandrapur', 'junagadh', 'thrissur', 'alwar', 'bardhaman', 'kakinada',
  'nizamabad', 'parbhani', 'tumkur', 'tumakuru', 'khammam', 'panipat', 'darbhanga', 'aizawl',
  'dewas', 'ichalkaranji', 'karnal', 'bathinda', 'jalna', 'eluru', 'barasat', 'purnia',
  'satna', 'farrukhabad', 'sagar', 'durg', 'imphal', 'ratlam', 'hapur', 'arrah', 'anantapur',
  'karimnagar', 'etawah', 'ambarnath', 'bharatpur', 'begusarai', 'gandhidham', 'sikar',
  'thoothukudi', 'tuticorin', 'rewa', 'mirzapur', 'raichur', 'ramagundam', 'haridwar',
  'vizianagaram', 'katihar', 'nagercoil', 'ganganagar', 'sriganganagar', 'thanjavur',
  'bulandshahr', 'sambhal', 'singrauli', 'nadiad', 'yamunanagar', 'bidar', 'munger',
  'panchkula', 'burhanpur', 'kharagpur', 'dindigul', 'gandhinagar', 'hospet', 'malda',
  'ongole', 'deoghar', 'chapra', 'haldia', 'khandwa', 'nandyal', 'morena', 'amroha', 'anand',
  'bhind', 'bhiwani', 'ambala', 'morbi', 'fatehpur', 'raebareli', 'chittoor', 'bhusawal',
  'bahraich', 'vellore', 'mehsana', 'raiganj', 'sirsa', 'danapur', 'serampore', 'jaunpur',
  'panvel', 'shivpuri', 'surendranagar', 'unnao', 'alappuzha', 'kottayam', 'machilipatnam',
  'shimla', 'adoni', 'udupi', 'tenali', 'proddatur', 'saharsa', 'hindupur', 'sasaram',
  'hajipur', 'bhimavaram', 'kumbakonam', 'madanapalle', 'siwan', 'bettiah', 'guntakal',
  'srikakulam', 'motihari', 'dharmavaram', 'gudivada', 'phagwara', 'pudukkottai', 'hosur',
  'suryapet', 'miryalaguda', 'karaikudi', 'kishanganj', 'buxar', 'tezpur', 'jehanabad',
  'gangtok', 'kohima', 'itanagar', 'shillong', 'dispur', 'kavaratti', 'silvassa',
  'trivandrum', 'thiruvananthapuram', 'palakkad', 'kannur', 'kasaragod', 'malappuram',
  'pathanamthitta', 'idukki', 'ernakulam', 'wayanad',
  // Towns seen in claim addresses
  'medchal', 'sanwer', 'karamsad', 'bhuvanagiri', 'chidambaram', 'cuddalore', 'kaisinghnagar',
  'raisinghnagar', 'yerawada', 'prabhadevi', 'goregaon', 'marathahalli', 'sarjapur',
  'perungudi', 'bhawarkuan', 'bhanwarkuan', 'rajpur', 'dehri', 'hazaribagh', 'bokaro', 'giridih',
];

/**
 * Words common in Indian addresses and names that sit one edit from a place and are NOT
 * misspellings of it: "Vikas Vihar" is not a misspelled Virar, "Durga Sai Mandir" not Durg,
 * "Kotak" (the bank) not Kota. Real words for the spell check, never near-miss targets.
 */
export const ADDRESS_WORDS: string[] = [
  'vihar', 'durga', 'kotak', 'deori', 'khanda', 'tripuri', 'mandir', 'mohalla', 'chowk',
  'bazar', 'bazaar', 'marg', 'galli', 'gali', 'basti', 'puram', 'pally', 'palli',
];
