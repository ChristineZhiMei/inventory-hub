import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import forge from "node-forge";

const CERTIFICATE_VERSION = 1;
const RENEW_BEFORE_MS = 30 * 24 * 60 * 60 * 1_000;

interface CertificateMetadata {
  version: number;
  addresses: string[];
  dnsNames: string[];
  expiresAt: string;
}

export interface LanCertificateBundle {
  tlsCertPath: string;
  tlsKeyPath: string;
  caCertPath: string;
  caFingerprint: string;
  primaryAddress: string;
  addresses: string[];
}

export function ensureLanCertificateBundle(dataDir: string): LanCertificateBundle {
  const certificateDir = join(dataDir, "security", "lan");
  mkdirSync(certificateDir, { recursive: true, mode: 0o700 });

  const caKeyPath = join(certificateDir, "ca-key.pem");
  const caPemPath = join(certificateDir, "ca-cert.pem");
  const caCertPath = join(certificateDir, "inventory-hub-ca.cer");
  const tlsKeyPath = join(certificateDir, "server-key.pem");
  const tlsCertPath = join(certificateDir, "server-chain.pem");
  const metadataPath = join(certificateDir, "metadata.json");

  const ca = loadOrCreateCertificateAuthority(caKeyPath, caPemPath, caCertPath);
  const addresses = availableLanAddresses();
  if (addresses.length === 0) {
    throw new Error("LAN_ADDRESS_UNAVAILABLE: 未发现可用于手机访问的局域网 IPv4 地址");
  }
  const dnsNames = availableDnsNames();
  const metadata = readMetadata(metadataPath);
  const shouldRenew =
    !existsSync(tlsKeyPath) ||
    !existsSync(tlsCertPath) ||
    !metadata ||
    metadata.version !== CERTIFICATE_VERSION ||
    metadata.expiresAt.localeCompare(new Date(Date.now() + RENEW_BEFORE_MS).toISOString()) <= 0 ||
    !sameValues(metadata.addresses, addresses) ||
    !sameValues(metadata.dnsNames, dnsNames);

  if (shouldRenew) {
    const leaf = createServerCertificate(ca.certificate, ca.privateKey, addresses, dnsNames);
    writePrivateFile(tlsKeyPath, forge.pki.privateKeyToPem(leaf.privateKey));
    writePrivateFile(
      tlsCertPath,
      `${forge.pki.certificateToPem(leaf.certificate)}${forge.pki.certificateToPem(ca.certificate)}`,
    );
    writePrivateFile(
      metadataPath,
      `${JSON.stringify(
        {
          version: CERTIFICATE_VERSION,
          addresses,
          dnsNames,
          expiresAt: leaf.certificate.validity.notAfter.toISOString(),
        } satisfies CertificateMetadata,
        null,
        2,
      )}\n`,
    );
  }

  const caDer = certificateDer(ca.certificate);
  return {
    tlsCertPath,
    tlsKeyPath,
    caCertPath,
    caFingerprint: formatFingerprint(createHash("sha256").update(caDer).digest("hex")),
    primaryAddress: addresses[0]!,
    addresses,
  };
}

function loadOrCreateCertificateAuthority(
  keyPath: string,
  pemPath: string,
  derPath: string,
): { certificate: forge.pki.Certificate; privateKey: forge.pki.rsa.PrivateKey } {
  if (existsSync(keyPath) && existsSync(pemPath)) {
    try {
      const privateKey = forge.pki.privateKeyFromPem(readFileSync(keyPath, "utf8"));
      const certificate = forge.pki.certificateFromPem(readFileSync(pemPath, "utf8"));
      if (certificate.validity.notAfter.getTime() > Date.now() + RENEW_BEFORE_MS) {
        if (!existsSync(derPath)) writePublicFile(derPath, certificateDer(certificate));
        return { certificate, privateKey: privateKey as forge.pki.rsa.PrivateKey };
      }
    } catch {
      // Replace an unreadable local authority. The old certificate could not
      // safely sign or validate a new service certificate anyway.
    }
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = serialNumber();
  certificate.validity.notBefore = new Date(Date.now() - 5 * 60 * 1_000);
  certificate.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1_000);
  const attributes = [
    { name: "commonName", value: "Inventory Hub Local CA" },
    { name: "organizationName", value: "Inventory Hub" },
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  writePrivateFile(keyPath, forge.pki.privateKeyToPem(keys.privateKey));
  writePublicFile(pemPath, forge.pki.certificateToPem(certificate));
  writePublicFile(derPath, certificateDer(certificate));
  return { certificate, privateKey: keys.privateKey };
}

function createServerCertificate(
  authority: forge.pki.Certificate,
  authorityKey: forge.pki.rsa.PrivateKey,
  addresses: string[],
  dnsNames: string[],
): { certificate: forge.pki.Certificate; privateKey: forge.pki.rsa.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = serialNumber();
  certificate.validity.notBefore = new Date(Date.now() - 5 * 60 * 1_000);
  certificate.validity.notAfter = new Date(Date.now() + 397 * 24 * 60 * 60 * 1_000);
  certificate.setSubject([
    { name: "commonName", value: addresses[0]! },
    { name: "organizationName", value: "Inventory Hub" },
  ]);
  certificate.setIssuer(authority.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectKeyIdentifier" },
    {
      name: "subjectAltName",
      altNames: [
        ...addresses.map((ip) => ({ type: 7, ip })),
        ...dnsNames.map((value) => ({ type: 2, value })),
      ],
    },
  ]);
  certificate.sign(authorityKey, forge.md.sha256.create());
  return { certificate, privateKey: keys.privateKey };
}

function availableLanAddresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);
  return [...new Set(addresses)].sort((left, right) => addressPriority(left) - addressPriority(right) || left.localeCompare(right));
}

function addressPriority(address: string): number {
  if (address.startsWith("192.168.")) return 0;
  if (address.startsWith("10.")) return 1;
  const second = Number(address.split(".")[1]);
  if (address.startsWith("172.") && second >= 16 && second <= 31) return 2;
  return 3;
}

function availableDnsNames(): string[] {
  const host = hostname().trim().toLocaleLowerCase();
  return [...new Set(["localhost", host, host && !host.endsWith(".local") ? `${host}.local` : host].filter(Boolean))];
}

function readMetadata(path: string): CertificateMetadata | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as CertificateMetadata;
    if (!Array.isArray(value.addresses) || !Array.isArray(value.dnsNames) || !value.expiresAt) return null;
    return value;
  } catch {
    return null;
  }
}

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function certificateDer(certificate: forge.pki.Certificate): Buffer {
  const bytes = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  return Buffer.from(bytes, "binary");
}

function serialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) || 1;
  return bytes.toString("hex");
}

function formatFingerprint(hex: string): string {
  return hex.toUpperCase().match(/.{2}/g)?.join(":") ?? hex.toUpperCase();
}

function writePrivateFile(path: string, value: string | Buffer): void {
  writeAtomically(path, value, 0o600);
}

function writePublicFile(path: string, value: string | Buffer): void {
  writeAtomically(path, value, 0o644);
}

function writeAtomically(path: string, value: string | Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, value, { mode });
  renameSync(temporaryPath, path);
}
