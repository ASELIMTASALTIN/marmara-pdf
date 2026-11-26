import forge from "node-forge";
import { certField } from "./identity";

/**
 * Minimal CMS (PKCS#7) SignedData builder and verifier for PDF signatures.
 * Detached content, SHA-256, RSA PKCS#1 v1.5, with the attributes PAdES
 * baseline signatures need (contentType, messageDigest, signingTime,
 * signingCertificateV2).
 */

const { asn1 } = forge;
const T = asn1.Type;
const C = asn1.Class;

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
};

const seq = (v: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SEQUENCE, true, v);
const set = (v: forge.asn1.Asn1[]) => asn1.create(C.UNIVERSAL, T.SET, true, v);
const oid = (o: string) => asn1.create(C.UNIVERSAL, T.OID, false, asn1.oidToDer(o).getBytes());
const nul = () => asn1.create(C.UNIVERSAL, T.NULL, false, "");
const octets = (b: string) => asn1.create(C.UNIVERSAL, T.OCTETSTRING, false, b);
const int = (bytes: string) => asn1.create(C.UNIVERSAL, T.INTEGER, false, bytes);
const algo = (o: string) => seq([oid(o), nul()]);
const der = (a: forge.asn1.Asn1) => asn1.toDer(a).getBytes();

function attribute(type: string, value: forge.asn1.Asn1) {
  return seq([oid(type), set([value])]);
}

function certDer(cert: forge.pki.Certificate): string {
  return der(forge.pki.certificateToAsn1(cert));
}

/** Builds a detached CMS signature for a SHA-256 digest (binary string). */
export function buildCms(digest: string, key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate, chain: forge.pki.Certificate[], date: Date): Uint8Array {
  const certHash = forge.md.sha256.create().update(certDer(cert)).digest().getBytes();
  const signedAttrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.signingTime, asn1.create(C.UNIVERSAL, T.UTCTIME, false, asn1.dateToUtcTime(date))),
    attribute(OID.messageDigest, octets(digest)),
    // SigningCertificateV2 ::= SEQ { certs SEQ OF ESSCertIDv2 }, ESSCertIDv2 ::= SEQ { certHash } (sha256 default)
    attribute(OID.signingCertificateV2, seq([seq([seq([octets(certHash)])])])),
  ];
  // The signature covers the DER of the attributes encoded as a SET OF.
  const toSign = der(set(signedAttrs));
  const md = forge.md.sha256.create().update(toSign);
  const signature = key.sign(md);

  let serial = cert.serialNumber;
  if (serial.length % 2) serial = "0" + serial;
  const signerInfo = seq([
    int(String.fromCharCode(1)),
    seq([forge.pki.distinguishedNameToAsn1(cert.issuer), int(forge.util.hexToBytes(serial))]),
    algo(OID.sha256),
    asn1.create(C.CONTEXT_SPECIFIC, 0, true, signedAttrs),
    algo(OID.rsaEncryption),
    octets(signature),
  ]);
  const signedData = seq([
    int(String.fromCharCode(1)),
    set([algo(OID.sha256)]),
    seq([oid(OID.data)]),
    asn1.create(C.CONTEXT_SPECIFIC, 0, true, [cert, ...chain].map((c) => forge.pki.certificateToAsn1(c))),
    set([signerInfo]),
  ]);
  const contentInfo = seq([oid(OID.signedData), asn1.create(C.CONTEXT_SPECIFIC, 0, true, [signedData])]);
  const out = der(contentInfo);
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface CmsVerification {
  /** Digest of the signed byte ranges matches the signed messageDigest. */
  integrity: boolean;
  /** Cryptographic signature over the signed attributes is valid. */
  signatureValid: boolean | null; // null = algorithm not supported
  signer?: string;
  issuer?: string;
  selfSigned?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  signingTime?: Date;
  digestAlgorithm?: string;
  error?: string;
  certificateDer?: string;
}

const DIGESTS: Record<string, () => forge.md.MessageDigest> = {
  [OID.sha1]: () => forge.md.sha1.create(),
  [OID.sha256]: () => forge.md.sha256.create(),
  [OID.sha384]: () => forge.md.sha384.create(),
  [OID.sha512]: () => forge.md.sha512.create(),
};
const DIGEST_NAMES: Record<string, string> = { [OID.sha1]: "SHA-1", [OID.sha256]: "SHA-256", [OID.sha384]: "SHA-384", [OID.sha512]: "SHA-512" };

function hashChunks(alg: string, data: Uint8Array): string {
  const md = DIGESTS[alg]();
  for (let i = 0; i < data.length; i += 0x10000) md.update(String.fromCharCode(...data.subarray(i, i + 0x10000)));
  return md.digest().getBytes();
}

/** Verifies a detached CMS signature (DER) against the signed content bytes. */
export function verifyCms(cmsDer: Uint8Array, content: Uint8Array): CmsVerification {
  try {
    let bin = "";
    for (let i = 0; i < cmsDer.length; i += 0x8000) bin += String.fromCharCode(...cmsDer.subarray(i, i + 0x8000));
    const ci = asn1.fromDer(bin, { strict: false, parseAllBytes: false } as never);
    const sd = (ci.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[];
    const signedData = sd[0].value as forge.asn1.Asn1[];
    // certificates: [0] IMPLICIT, signerInfos: last SET
    const certsNode = signedData.find((n) => n.tagClass === C.CONTEXT_SPECIFIC && n.type === 0);
    const signerInfos = signedData[signedData.length - 1].value as forge.asn1.Asn1[];
    const si = signerInfos[0].value as forge.asn1.Asn1[];
    const sid = si[1];
    const digestAlg = asn1.derToOid(((si[2].value as forge.asn1.Asn1[])[0].value as string));
    let idx = 3;
    let signedAttrsNode: forge.asn1.Asn1 | null = null;
    if (si[idx].tagClass === C.CONTEXT_SPECIFIC && si[idx].type === 0) signedAttrsNode = si[idx++];
    const sigAlg = asn1.derToOid(((si[idx++].value as forge.asn1.Asn1[])[0].value as string));
    const signature = si[idx].value as string;
    if (!DIGESTS[digestAlg]) return { integrity: false, signatureValid: null, error: `Unsupported digest algorithm ${digestAlg}` };

    // Signer certificate: match IssuerAndSerialNumber.
    const serialHex = forge.util.bytesToHex((sid.value as forge.asn1.Asn1[])[1].value as string).replace(/^0+/, "");
    let cert: forge.pki.Certificate | undefined;
    let certNode: forge.asn1.Asn1 | undefined;
    for (const c of (certsNode?.value as forge.asn1.Asn1[]) ?? []) {
      try {
        const parsed = forge.pki.certificateFromAsn1(c);
        if (parsed.serialNumber.replace(/^0+/, "") === serialHex) {
          cert = parsed;
          certNode = c;
          break;
        }
      } catch {
        // Non-RSA certificates cannot be parsed by forge; still check integrity below.
        certNode ??= c;
      }
    }

    const contentDigest = hashChunks(digestAlg, content);
    let integrity: boolean;
    let signingTime: Date | undefined;
    let tbs: string;
    if (signedAttrsNode) {
      let md: string | null = null;
      for (const a of signedAttrsNode.value as forge.asn1.Asn1[]) {
        const parts = a.value as forge.asn1.Asn1[];
        const type = asn1.derToOid(parts[0].value as string);
        const val = (parts[1].value as forge.asn1.Asn1[])[0];
        if (type === OID.messageDigest) md = val.value as string;
        if (type === OID.signingTime) {
          try {
            signingTime = val.type === T.UTCTIME ? asn1.utcTimeToDate(val.value as string) : asn1.generalizedTimeToDate(val.value as string);
          } catch {
            /* ignore malformed time */
          }
        }
      }
      integrity = md === contentDigest;
      // Re-encode the [0] IMPLICIT attributes as a SET OF for signature verification.
      tbs = der(set(signedAttrsNode.value as forge.asn1.Asn1[]));
    } else {
      integrity = true; // checked by the signature itself
      tbs = "";
    }

    let signatureValid: boolean | null = null;
    if (cert && (sigAlg === OID.rsaEncryption || sigAlg === OID.sha256WithRSA || /^1\.2\.840\.113549\.1\.1\./.test(sigAlg))) {
      const md = DIGESTS[digestAlg]();
      if (signedAttrsNode) md.update(tbs);
      else for (let i = 0; i < content.length; i += 0x10000) md.update(String.fromCharCode(...content.subarray(i, i + 0x10000)));
      try {
        signatureValid = (cert.publicKey as forge.pki.rsa.PublicKey).verify(md.digest().getBytes(), signature);
      } catch {
        signatureValid = false;
      }
      if (!signedAttrsNode) integrity = signatureValid;
    }
    const field = (c: forge.pki.Certificate, f: "subject" | "issuer") => certField(c, f, "CN") ?? certField(c, f, "O") ?? "Unknown";
    return {
      integrity,
      signatureValid,
      signer: cert ? field(cert, "subject") : undefined,
      issuer: cert ? field(cert, "issuer") : undefined,
      selfSigned: cert ? cert.isIssuer(cert) : undefined,
      notBefore: cert?.validity.notBefore,
      notAfter: cert?.validity.notAfter,
      signingTime,
      digestAlgorithm: DIGEST_NAMES[digestAlg],
      certificateDer: certNode ? der(certNode) : undefined,
      error: cert ? undefined : "The signer certificate uses an algorithm that cannot be checked here (only RSA).",
    };
  } catch (e) {
    return { integrity: false, signatureValid: false, error: `The signature data is damaged: ${(e as Error).message}` };
  }
}
