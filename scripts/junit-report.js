function decodeXmlAttribute(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function attributesFromTag(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/\b([A-Za-z_:][A-Za-z0-9_.:-]*)="([^"]*)"/g)) {
    attributes[match[1]] = decodeXmlAttribute(match[2]);
  }
  return attributes;
}

export function parseJunitReport(junit) {
  const testCases = [...String(junit || '').matchAll(/<testcase\b[^>]*>/g)].map((match) => {
    const attributes = attributesFromTag(match[0]);
    return {
      name: attributes.name || '<unnamed>',
      durationMs: Number(attributes.time || 0) * 1000,
    };
  });
  const reportedDurationMs = Number(
    String(junit || '').match(/<!--\s*duration_ms\s+([0-9.]+)\s*-->/)?.[1] || 0,
  );
  return { testCases, reportedDurationMs };
}
