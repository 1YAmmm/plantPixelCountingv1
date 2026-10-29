import { crc32, PACKET_CHUNK, PACKET_END, PACKET_START } from "@/lib/ble/protocol";

/** The Data packets of one preview frame, as the firmware's sendPreview() writes them. */
export function framePackets(jpeg: Uint8Array, { chunkSize = 200, width = 640, height = 480, frameId = 1, crc = crc32(jpeg) } = {}): DataView[] {
  const chunks = Math.ceil(jpeg.length / chunkSize);
  const start = new DataView(new ArrayBuffer(19));
  start.setUint8(0, PACKET_START);
  start.setUint32(1, jpeg.length, true);
  start.setUint16(5, chunks, true);
  start.setUint32(7, crc, true);
  start.setUint16(11, chunkSize, true);
  start.setUint16(13, width, true);
  start.setUint16(15, height, true);
  start.setUint16(17, frameId, true);
  const packets = [start];
  for (let seq = 0; seq < chunks; seq++) {
    const payload = jpeg.subarray(seq * chunkSize, (seq + 1) * chunkSize);
    const chunk = new DataView(new ArrayBuffer(3 + payload.length));
    chunk.setUint8(0, PACKET_CHUNK);
    chunk.setUint16(1, seq, true);
    new Uint8Array(chunk.buffer).set(payload, 3);
    packets.push(chunk);
  }
  const end = new DataView(new ArrayBuffer(5));
  end.setUint8(0, PACKET_END);
  end.setUint16(1, chunks, true);
  end.setUint16(3, frameId, true);
  packets.push(end);
  return packets;
}
