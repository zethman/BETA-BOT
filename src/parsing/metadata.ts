import { Connection, PublicKey } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getExtensionData,
  unpackMint,
} from "@solana/spl-token";
import { unpack as unpackToken2022Metadata } from "@solana/spl-token-metadata";
import { throttledRpcCall } from "../data/rpcThrottle.js";
import { logger } from "../logger.js";

// Metaplex Token Metadata program — stable, well-known address.
const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Fixed field sizes in the Metaplex Metadata account Data struct.
const METAPLEX_NAME_BUF = 32;
const METAPLEX_SYMBOL_BUF = 10;
const METAPLEX_URI_BUF = 200;

export function getMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM_ID
  );
  return pda;
}

function readMetaplexString(data: Buffer, offset: number, bufSize: number): string {
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const raw = data.subarray(start, start + Math.min(len, bufSize));
  const nullIdx = raw.indexOf(0);
  const trimmed = nullIdx === -1 ? raw : raw.subarray(0, nullIdx);
  return trimmed.toString("utf8").trim();
}

/**
 * Legacy SPL Token mints store name/symbol/uri in a separate Metaplex
 * Metadata PDA. Layout (v1):
 *   1 byte key + 32 byte update_authority + 32 byte mint
 *   then fixed-capacity name (4 + 32), symbol (4 + 10), uri (4 + 200).
 */
function parseMetaplexMetadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  if (data.length < 115) return null;

  const nameOffset = 1 + 32 + 32;
  const symbolOffset = nameOffset + 4 + METAPLEX_NAME_BUF;
  const uriOffset = symbolOffset + 4 + METAPLEX_SYMBOL_BUF;

  const name = readMetaplexString(data, nameOffset, METAPLEX_NAME_BUF);
  const symbol = readMetaplexString(data, symbolOffset, METAPLEX_SYMBOL_BUF);
  const uri = readMetaplexString(data, uriOffset, METAPLEX_URI_BUF);

  if (!name && !symbol) return null;
  return { name, symbol, uri };
}

/**
 * pump.fun create_v2 mints are Token-2022 accounts with metadata stored
 * as an on-mint extension (no Metaplex PDA). Parse it from tlvData so we
 * only need the single getAccountInfo call we already made for the mint.
 */
function parseToken2022Metadata(
  mint: PublicKey,
  accountData: Buffer
): { name: string; symbol: string; uri: string } | null {
  try {
    const mintInfo = unpackMint(mint, { data: accountData, executable: false, lamports: 0, owner: TOKEN_2022_PROGRAM_ID }, TOKEN_2022_PROGRAM_ID);
    const extensionData = getExtensionData(ExtensionType.TokenMetadata, mintInfo.tlvData);
    if (!extensionData) return null;

    const meta = unpackToken2022Metadata(extensionData);
    if (!meta.name && !meta.symbol) return null;
    return { name: meta.name, symbol: meta.symbol, uri: meta.uri };
  } catch (err) {
    logger.warn(`Token-2022 metadata parse failed for ${mint.toBase58()}:`, err);
    return null;
  }
}

async function fetchMetaplexMetadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  const pda = getMetadataPda(mint);
  const accountInfo = await throttledRpcCall(() => connection.getAccountInfo(pda));
  if (!accountInfo) return null;
  return parseMetaplexMetadata(accountInfo.data);
}

/**
 * Best-effort name/symbol/uri for pump.fun tokens — supports both
 * Token-2022 (create_v2) and legacy Metaplex metadata accounts.
 */
export async function fetchTokenMetadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  try {
    const mintInfo = await throttledRpcCall(() => connection.getAccountInfo(mint));
    if (!mintInfo) return null;

    if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      const token2022 = parseToken2022Metadata(mint, mintInfo.data);
      if (token2022) return token2022;
    }

    return fetchMetaplexMetadata(connection, mint);
  } catch (err) {
    logger.warn(`Metadata fetch failed for ${mint.toBase58()}:`, err);
    return null;
  }
}
