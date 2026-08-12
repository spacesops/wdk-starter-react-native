import { normalizeAnchorsJsonForLibveritas } from '@/utils/get-anchors-json';
import {
  sortZonesForQuery,
  summarizeVerifiedZones,
  type VerifiedZoneSummary,
} from '@/utils/extract-zone-attributes';

export type { VerifiedZoneSummary } from '@/utils/extract-zone-attributes';

export type VerifyQueryMessageResult = {
  zones: VerifiedZoneSummary[];
  raw: unknown;
};

/**
 * Verify a relay /query response against trust anchors using libveritas.
 * The libveritas package itself is imported lazily by the caller.
 */
export async function verifyQueryMessage(
  anchorsJsonString: string,
  messageBytes: ArrayBuffer,
  queryName?: string
): Promise<VerifyQueryMessageResult> {
  console.log('[Spaces] verifyQueryMessage: importing libveritas…');
  const { Anchors, Message, QueryContext, Veritas } = await import(
    '@spacesprotocol/react-native-libveritas'
  );
  console.log('[Spaces] verifyQueryMessage: libveritas module loaded');

  const libveritasAnchorsJson = normalizeAnchorsJsonForLibveritas(anchorsJsonString);
  console.log(
    `[Spaces] verifyQueryMessage: anchors entries=${JSON.parse(libveritasAnchorsJson).length}`
  );

  const anchors = Anchors.fromJson(libveritasAnchorsJson);
  const veritas = new Veritas(anchors);

  const ctx = new QueryContext();
  const msg = new Message(messageBytes);
  console.log(
    `[Spaces] verifyQueryMessage: calling veritas.verify (q=${queryName ?? 'all'}, bytes=${messageBytes.byteLength})…`
  );
  const result = veritas.verify(ctx, msg);

  const zoneSummaries = await summarizeVerifiedZones(result.zones());
  const zones = queryName ? sortZonesForQuery(zoneSummaries, queryName) : zoneSummaries;

  for (const zone of zones) {
    console.log(`${zone.handle} -> ${zone.sovereignty}`);
    for (const attr of zone.attributes) {
      console.log(`  ${attr.type} ${attr.key}=${attr.values.join(', ')}`);
    }
  }

  return { zones, raw: result };
}
