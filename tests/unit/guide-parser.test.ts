import { describe, expect, it } from 'vitest';
import { decodeEntities, parseXMLTV, parseXmltvDate, XmltvStreamParser, type RawProgramme, type XmltvChannel } from '../../src/lib/xmltv';

function scan(chunks: string[], accept?: (ch: string, start: number, stop: number | null) => boolean) {
  const channels: XmltvChannel[] = [];
  const programmes: RawProgramme[] = [];
  const p = new XmltvStreamParser({ channel: (c) => channels.push(c), programme: (x) => programmes.push(x), accept });
  for (const c of chunks) p.push(c);
  p.end();
  return { channels, programmes, parser: p };
}

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<!-- generated -->
<tv generator-info-name="x">
  <channel id="espn.us"><display-name lang="en">ESPN</display-name><display-name>ESPN HD</display-name><icon src="https://x/espn.png"/></channel>
  <channel id='a&amp;e.us'><display-name>A&amp;E</display-name></channel>
  <programme stop="20261004130000 +0000" channel="espn.us" start="20261004120000 +0000">
    <title lang="en">SportsCenter &amp; More</title>
    <sub-title><![CDATA[Live <from> Bristol & more]]></sub-title>
    <desc>Scores &lt;today&gt; &#8212; &#x2014; &quot;big&quot; &apos;night&apos;</desc>
    <category>Sports</category><category>News</category>
    <new />
  </programme>
  <programme start='20261004130000 +0000' channel='a&amp;e.us'><title>Open ended</title></programme>
  <programme start="20261004150000 +0000" stop="20261004160000 +0000" channel="a&amp;e.us"><title>Next</title></programme>
</tv>`;

describe('XMLTV stream parser', () => {
  it('reads channels, attributes in any order/quotes, entities, CDATA, flags', () => {
    const { channels, programmes, parser } = scan([DOC]);
    expect(parser.sawRoot).toBe(true);
    expect(channels).toEqual([
      { id: 'espn.us', names: ['ESPN', 'ESPN HD'], icon: 'https://x/espn.png' },
      { id: 'a&e.us', names: ['A&E'] },
    ]);
    expect(programmes).toHaveLength(3);
    const sc = programmes[0];
    expect(sc).toMatchObject({ channel: 'espn.us', title: 'SportsCenter & More', subtitle: 'Live <from> Bristol & more', categories: ['Sports', 'News'], isNew: true });
    expect(sc.desc).toBe('Scores <today> — — "big" \'night\'');
    expect(sc.start).toBe(Date.UTC(2026, 9, 4, 12));
    expect(sc.stop).toBe(Date.UTC(2026, 9, 4, 13));
    expect(programmes[1]).toMatchObject({ channel: 'a&e.us', stop: null, title: 'Open ended' });
  });

  it('gives the same result for any chunking (tags, entities and CDATA split across chunks)', () => {
    const whole = scan([DOC]);
    for (const size of [1, 2, 3, 7, 13, 64]) {
      const chunks: string[] = [];
      for (let i = 0; i < DOC.length; i += size) chunks.push(DOC.slice(i, i + size));
      const r = scan(chunks);
      expect(r.channels).toEqual(whole.channels);
      expect(r.programmes).toEqual(whole.programmes);
    }
  });

  it('skips unwanted programmes without parsing their bodies, also across chunk boundaries', () => {
    const chunks: string[] = [];
    for (let i = 0; i < DOC.length; i += 5) chunks.push(DOC.slice(i, i + 5));
    const r = scan(chunks, (ch) => ch !== 'espn.us');
    expect(r.programmes.map((p) => p.title)).toEqual(['Open ended', 'Next']);
    expect(r.parser.skipped).toBe(1);
  });

  it('tolerates malformed input', () => {
    const bad = `<tv><channel id="x"><display-name>X</display-name>
      <programme channel="x" start="20261004120000"><title>Unclosed channel before me</title></programme>
      <programme channel="x"><title>No start</title></programme>
      <programme channel="x" start="20261004130000"><desc>No title</desc></programme>
      <programme channel="x" start="20261004140000"><title>AT&T <3 stray</title></programme>
      <programme channel="x" start="20261004150000" stop="garbage"><title>Bad stop</title><title>Second title ignored</title></programme>
      <programme channel="x" start="20261004160000"><title>Cut off`;
    const { programmes, parser } = scan([bad]);
    expect(programmes.map((p) => p.title)).toContain('Unclosed channel before me');
    expect(programmes.find((p) => p.title === 'Bad stop')).toMatchObject({ stop: null });
    expect(programmes.some((p) => p.title === 'No start' || p.title === 'Cut off')).toBe(false);
    expect(parser.errors).toBeGreaterThan(0);
  });

  it('keeps memory bounded on a runaway tag', () => {
    const junk = `<tv><programme channel="x start="20261004120000">` + 'x'.repeat(200_000) + `</tv>`;
    expect(() => scan([junk])).not.toThrow();
  });
});

describe('XMLTV dates and entities', () => {
  it('handles offsets incl. +0530, +01:00, Z and none', () => {
    expect(parseXmltvDate('20261003120000 +0530')).toBe(Date.UTC(2026, 9, 3, 6, 30));
    expect(parseXmltvDate('20261003120000 -0400')).toBe(Date.UTC(2026, 9, 3, 16));
    expect(parseXmltvDate('20261003120000 +01:00')).toBe(Date.UTC(2026, 9, 3, 11));
    expect(parseXmltvDate('20261003120000Z')).toBe(Date.UTC(2026, 9, 3, 12));
    expect(parseXmltvDate('20261003120000')).toBe(Date.UTC(2026, 9, 3, 12));
    expect(parseXmltvDate('202610031200')).toBe(Date.UTC(2026, 9, 3, 12));
    expect(parseXmltvDate('')).toBeNull();
  });
  it('decodes named and numeric references, keeps unknown ones', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65;&#x42; &bogus; &')).toBe('a & b <c> AB &bogus; &');
  });
});

describe('parseXMLTV (whole document)', () => {
  it('fills a missing stop with the next start', () => {
    const r = parseXMLTV(DOC);
    expect(r.programs.find((p) => p.title === 'Open ended')!.end).toBe(Date.UTC(2026, 9, 4, 15));
    expect(r.programs.find((p) => p.title === 'SportsCenter & More')).toMatchObject({ isSports: true, isNew: true, category: 'Sports' });
  });
  it('still rejects documents with nothing usable', () => {
    expect(() => parseXMLTV('<html><body>Not found</body></html>')).toThrow(/not well-formed/);
    expect(parseXMLTV('<tv></tv>').programs).toEqual([]);
  });
});
