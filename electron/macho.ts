/** Read the architecture table from Mach-O headers without invoking Xcode tools.
 * Format: Apple's mach-o/loader.h, mach-o/fat.h and mach/machine.h. Signature
 * verification separately validates the complete executable and its slices. */
export function machArchitectures(header: Buffer): string[] {
  if (header.length < 8) return [];
  const magic = header.readUInt32BE(0);
  const name = (cpu: number) => (cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : '');
  if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
    if (header.length < 32) return [];
    const cpu = magic === 0xcffaedfe ? header.readUInt32LE(4) : header.readUInt32BE(4);
    return [name(cpu)].filter(Boolean);
  }
  if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) return [];
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const read = (offset: number) => (little ? header.readUInt32LE(offset) : header.readUInt32BE(offset));
  const count = read(4);
  const stride = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
  if (count < 1 || count > 32 || header.length < 8 + count * stride) return [];
  return [...new Set(Array.from({ length: count }, (_, i) => name(read(8 + i * stride))).filter(Boolean))];
}
