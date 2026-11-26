import forge from "node-forge";

/**
 * Digital IDs (certificate + private key) for signing. IDs are kept as
 * password-protected PKCS#12 blobs; the private key is only decrypted in
 * memory, when signing.
 */

export interface DigitalIdInfo {
  id: string;
  name: string;
  email?: string;
  organization?: string;
  issuer: string;
  selfSigned: boolean;
  notBefore: string;
  notAfter: string;
  /** SHA-256 fingerprint of the certificate (hex). */
  fingerprint: string;
}

export interface StoredDigitalId extends DigitalIdInfo {
  /** Password-protected PKCS#12, base64. */
  p12: string;
}

export interface UnlockedId {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
}

/** Reads a certificate name attribute, decoding UTF-8 strings (e.g. Turkish names). */
export function certField(cert: forge.pki.Certificate, field: "subject" | "issuer", name: string | { type: string }): string | undefined {
  const f = cert[field].getField(name as string);
  if (!f || typeof f.value !== "string") return undefined;
  // forge encodes UTF8String values on write but returns them still UTF-8 encoded on read.
  if ((f.valueTagClass as unknown) === forge.asn1.Type.UTF8) {
    try {
      return forge.util.decodeUtf8(f.value);
    } catch {
      return f.value;
    }
  }
  return f.value;
}
const attr = certField;
/** UTF-8 encoded attribute value tagged as UTF8String (forge needs this for non-ASCII text). */
const utf8 = (shortName: string, value: string): forge.pki.CertificateField =>
  ({ shortName, value, valueTagClass: forge.asn1.Type.UTF8 }) as unknown as forge.pki.CertificateField;

function fingerprint(cert: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  return forge.md.sha256.create().update(der).digest().toHex();
}

export function describeCertificate(cert: forge.pki.Certificate): Omit<DigitalIdInfo, "id"> {
  const name = attr(cert, "subject", "CN") ?? attr(cert, "subject", "O") ?? "Unknown";
  const issuer = attr(cert, "issuer", "CN") ?? attr(cert, "issuer", "O") ?? "Unknown";
  return {
    name,
    email: attr(cert, "subject", "E") ?? attr(cert, "subject", { type: "1.2.840.113549.1.9.1" }),
    organization: attr(cert, "subject", "O"),
    issuer,
    selfSigned: cert.isIssuer(cert),
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
    fingerprint: fingerprint(cert),
  };
}

function bytesToBinary(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}
export function binaryToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Opens a PKCS#12 file. Throws a friendly error on a wrong password. */
export function openPkcs12(p12Bytes: Uint8Array, password: string): UnlockedId {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(bytesToBinary(p12Bytes));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/mac|password|decrypt|invalid/i.test(msg)) throw new Error("Wrong password, or the file is not a valid digital ID (.pfx / .p12).");
    throw new Error(`The digital ID could not be read: ${msg}`);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBags.find((b) => b.key)?.key as forge.pki.rsa.PrivateKey | undefined;
  const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  if (!key) throw new Error("The digital ID does not contain a private key (only RSA keys are supported).");
  if (!certs.length) throw new Error("The digital ID does not contain a certificate.");
  // The signing certificate is the one matching the private key.
  const cert =
    certs.find((c) => {
      const pub = c.publicKey as forge.pki.rsa.PublicKey;
      return pub.n && pub.n.equals(key.n);
    }) ?? certs[0];
  return { key, cert, chain: certs.filter((c) => c !== cert) };
}

/** Validates a .pfx/.p12 and wraps it for storage. */
export function importDigitalId(p12Bytes: Uint8Array, password: string, id: string): StoredDigitalId {
  const { cert } = openPkcs12(p12Bytes, password);
  return { id, ...describeCertificate(cert), p12: forge.util.encode64(bytesToBinary(p12Bytes)) };
}

export function unlockDigitalId(stored: StoredDigitalId, password: string): UnlockedId {
  return openPkcs12(binaryToBytes(forge.util.decode64(stored.p12)), password);
}

export function digitalIdBytes(stored: StoredDigitalId): Uint8Array {
  return binaryToBytes(forge.util.decode64(stored.p12));
}

/** Generates an RSA-2048 key (natively via WebCrypto) and a self-signed signing certificate. */
export async function createSelfSignedId(
  subject: { name: string; email?: string; organization?: string; country?: string },
  password: string,
  id: string,
  years = 5,
): Promise<StoredDigitalId> {
  if (!subject.name.trim()) throw new Error("Enter a name for the digital ID.");
  if (password.length < 6) throw new Error("Use a password of at least 6 characters.");
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(bytesToBinary(pkcs8))) as forge.pki.rsa.PrivateKey;
  const pub = forge.pki.setRsaPublicKey(key.n, key.e);

  const cert = forge.pki.createCertificate();
  cert.publicKey = pub;
  cert.serialNumber = "01" + forge.util.bytesToHex(forge.random.getBytesSync(15));
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 60_000);
  cert.validity.notAfter = new Date(now.getFullYear() + years, now.getMonth(), now.getDate());
  const attrs: forge.pki.CertificateField[] = [utf8("CN", subject.name.trim())];
  if (subject.organization?.trim()) attrs.push(utf8("O", subject.organization.trim()));
  if (subject.country?.trim()) attrs.push({ shortName: "C", value: subject.country.trim().slice(0, 2).toUpperCase() });
  if (subject.email?.trim()) attrs.push({ name: "emailAddress", value: subject.email.trim() });
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", emailProtection: true, codeSigning: false },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  return { id, ...describeCertificate(cert), p12: forge.util.encode64(der) };
}
