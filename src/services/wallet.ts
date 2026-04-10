import algosdk from "algosdk";

export function normalizeWalletAddress(walletAddress: string) {
  return walletAddress.trim().toUpperCase();
}

export function isValidAlgorandAddress(walletAddress: string) {
  return algosdk.isValidAddress(normalizeWalletAddress(walletAddress));
}

export function verifyWalletSignature(input: {
  walletAddress: string;
  signedMessage: string;
  signature: string;
}) {
  const wallet = normalizeWalletAddress(input.walletAddress);
  const messageBytes = new TextEncoder().encode(input.signedMessage);
  const signatureBytes = decodeSignature(input.signature);

  if (!signatureBytes) {
    return false;
  }

  try {
    return algosdk.verifyBytes(messageBytes, signatureBytes, wallet);
  } catch {
    return false;
  }
}

function decodeSignature(signature: string) {
  const compact = signature.trim();
  try {
    return new Uint8Array(Buffer.from(compact, "base64"));
  } catch {
    // Fall through to hex decoder.
  }

  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    try {
      return new Uint8Array(Buffer.from(compact, "hex"));
    } catch {
      return null;
    }
  }

  return null;
}

export function parseGitHubRepo(repoUrl: string) {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git|\/)?$/);
  if (!match) {
    return null;
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}
