/**
 * Glyph name → Unicode for names commonly found in /Differences arrays
 * (subset of the Adobe Glyph List covering Latin-1, Latin Extended-A and
 * typographic punctuation). uniXXXX / uXXXXX names are handled in code.
 */
const TABLE =
  "space:20,exclam:21,quotedbl:22,numbersign:23,dollar:24,percent:25,ampersand:26,quotesingle:27,quoteright:2019,parenleft:28,parenright:29," +
  "asterisk:2a,plus:2b,comma:2c,hyphen:2d,minus:2212,period:2e,slash:2f,zero:30,one:31,two:32,three:33,four:34,five:35,six:36,seven:37," +
  "eight:38,nine:39,colon:3a,semicolon:3b,less:3c,equal:3d,greater:3e,question:3f,at:40,bracketleft:5b,backslash:5c,bracketright:5d," +
  "asciicircum:5e,underscore:5f,grave:60,quoteleft:2018,braceleft:7b,bar:7c,braceright:7d,asciitilde:7e,exclamdown:a1,cent:a2,sterling:a3," +
  "currency:a4,yen:a5,brokenbar:a6,section:a7,dieresis:a8,copyright:a9,ordfeminine:aa,guillemotleft:ab,logicalnot:ac,registered:ae," +
  "macron:af,degree:b0,plusminus:b1,twosuperior:b2,threesuperior:b3,acute:b4,mu:b5,paragraph:b6,periodcentered:b7,cedilla:b8," +
  "onesuperior:b9,ordmasculine:ba,guillemotright:bb,onequarter:bc,onehalf:bd,threequarters:be,questiondown:bf,Agrave:c0,Aacute:c1," +
  "Acircumflex:c2,Atilde:c3,Adieresis:c4,Aring:c5,AE:c6,Ccedilla:c7,Egrave:c8,Eacute:c9,Ecircumflex:ca,Edieresis:cb,Igrave:cc,Iacute:cd," +
  "Icircumflex:ce,Idieresis:cf,Eth:d0,Ntilde:d1,Ograve:d2,Oacute:d3,Ocircumflex:d4,Otilde:d5,Odieresis:d6,multiply:d7,Oslash:d8,Ugrave:d9," +
  "Uacute:da,Ucircumflex:db,Udieresis:dc,Yacute:dd,Thorn:de,germandbls:df,agrave:e0,aacute:e1,acircumflex:e2,atilde:e3,adieresis:e4," +
  "aring:e5,ae:e6,ccedilla:e7,egrave:e8,eacute:e9,ecircumflex:ea,edieresis:eb,igrave:ec,iacute:ed,icircumflex:ee,idieresis:ef,eth:f0," +
  "ntilde:f1,ograve:f2,oacute:f3,ocircumflex:f4,otilde:f5,odieresis:f6,divide:f7,oslash:f8,ugrave:f9,uacute:fa,ucircumflex:fb,udieresis:fc," +
  "yacute:fd,thorn:fe,ydieresis:ff,Amacron:100,amacron:101,Abreve:102,abreve:103,Aogonek:104,aogonek:105,Cacute:106,cacute:107," +
  "Ccircumflex:108,ccircumflex:109,Cdotaccent:10a,cdotaccent:10b,Ccaron:10c,ccaron:10d,Dcaron:10e,dcaron:10f,Dcroat:110,dcroat:111," +
  "Emacron:112,emacron:113,Ebreve:114,ebreve:115,Edotaccent:116,edotaccent:117,Eogonek:118,eogonek:119,Ecaron:11a,ecaron:11b," +
  "Gcircumflex:11c,gcircumflex:11d,Gbreve:11e,gbreve:11f,Gdotaccent:120,gdotaccent:121,Gcommaaccent:122,gcommaaccent:123," +
  "Hcircumflex:124,hcircumflex:125,Hbar:126,hbar:127,Itilde:128,itilde:129,Imacron:12a,imacron:12b,Ibreve:12c,ibreve:12d,Iogonek:12e," +
  "iogonek:12f,Idotaccent:130,Idot:130,dotlessi:131,IJ:132,ij:133,Jcircumflex:134,jcircumflex:135,Kcommaaccent:136,kcommaaccent:137," +
  "kgreenlandic:138,Lacute:139,lacute:13a,Lcommaaccent:13b,lcommaaccent:13c,Lcaron:13d,lcaron:13e,Ldot:13f,ldot:140,Lslash:141,lslash:142," +
  "Nacute:143,nacute:144,Ncommaaccent:145,ncommaaccent:146,Ncaron:147,ncaron:148,napostrophe:149,Eng:14a,eng:14b,Omacron:14c,omacron:14d," +
  "Obreve:14e,obreve:14f,Ohungarumlaut:150,ohungarumlaut:151,OE:152,oe:153,Racute:154,racute:155,Rcommaaccent:156,rcommaaccent:157," +
  "Rcaron:158,rcaron:159,Sacute:15a,sacute:15b,Scircumflex:15c,scircumflex:15d,Scedilla:15e,scedilla:15f,Scaron:160,scaron:161," +
  "Tcommaaccent:162,tcommaaccent:163,Tcaron:164,tcaron:165,Tbar:166,tbar:167,Utilde:168,utilde:169,Umacron:16a,umacron:16b,Ubreve:16c," +
  "ubreve:16d,Uring:16e,uring:16f,Uhungarumlaut:170,uhungarumlaut:171,Uogonek:172,uogonek:173,Wcircumflex:174,wcircumflex:175," +
  "Ycircumflex:176,ycircumflex:177,Ydieresis:178,Zacute:179,zacute:17a,Zdotaccent:17b,zdotaccent:17c,Zcaron:17d,zcaron:17e,florin:192," +
  "circumflex:2c6,caron:2c7,breve:2d8,dotaccent:2d9,ring:2da,ogonek:2db,tilde:2dc,hungarumlaut:2dd,endash:2013,emdash:2014," +
  "quotesinglbase:201a,quotedblleft:201c,quotedblright:201d,quotedblbase:201e,dagger:2020,daggerdbl:2021,bullet:2022,ellipsis:2026," +
  "perthousand:2030,guilsinglleft:2039,guilsinglright:203a,fraction:2044,Euro:20ac,trademark:2122,fi:fb01,fl:fb02,ff:fb00,ffi:fb03," +
  "ffl:fb04,nbspace:a0,sfthyphen:ad,Scommaaccent:218,scommaaccent:219,Tcedilla:162,tcedilla:163,lira:20a4,notequal:2260,lessequal:2264," +
  "greaterequal:2265,infinity:221e,partialdiff:2202,summation:2211,product:220f,radical:221a,approxequal:2248,Delta:2206,Omega:2126,pi:3c0," +
  "lozenge:25ca,dotlessj:237";

const MAP = new Map<string, string>();
for (const pair of TABLE.split(",")) {
  const [n, h] = pair.split(":");
  MAP.set(n, String.fromCodePoint(parseInt(h, 16)));
}
for (let c = 0x41; c <= 0x5a; c++) MAP.set(String.fromCharCode(c), String.fromCharCode(c));
for (let c = 0x61; c <= 0x7a; c++) MAP.set(String.fromCharCode(c), String.fromCharCode(c));

export function glyphNameToUnicode(name: string): string | undefined {
  const hit = MAP.get(name);
  if (hit) return hit;
  const base = name.split(".")[0].split("_")[0];
  if (base !== name && MAP.has(base)) return MAP.get(base);
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (m) {
    const hex = name.slice(3);
    let s = "";
    for (let i = 0; i < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return undefined;
}
