const PAPER_BASE = 'https://huggingface.co/papers';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanAbstract(value) {
  return clean(value)
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/~/g, ' ');
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseDailyPapers(json) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  const items = [];
  const seen = new Set();
  for (const entry of data) {
    const paper = entry?.paper ?? entry;
    const id = clean(paper?.id);
    const title = clean(paper?.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const organization = paper?.organization ?? entry?.organization ?? null;
    const comments = Number(entry?.numComments ?? paper?.numComments ?? 0);
    items.push({
      id,
      title,
      summary: cleanAbstract(paper?.summary).slice(0, 2400),
      published: clean(paper?.publishedAt || paper?.submittedOnDailyAt),
      featuredAt: clean(paper?.submittedOnDailyAt),
      url: `${PAPER_BASE}/${id}`,
      comments: Number.isFinite(comments) ? comments : 0,
      organization: clean(organization?.fullname || organization?.name),
    });
  }
  return items;
}

export function isNotableOrganization(organization, names = []) {
  const org = clean(organization).toLowerCase();
  if (!org) return false;
  return names.some((name) => {
    const needle = clean(name).toLowerCase();
    if (!needle) return false;
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(org);
  });
}

export function selectDailyPapers(items, settings = {}) {
  const minComments = Number(settings.min_comments ?? 4);
  const notableMinComments = Number(settings.notable_min_comments ?? 2);
  const maxCandidates = Math.max(1, Number(settings.max_candidates ?? 3) || 3);
  const notable = Array.isArray(settings.notable_organizations) ? settings.notable_organizations : [];

  return [...items]
    .filter((item) => {
      if (item.comments >= minComments) return true;
      return item.comments >= notableMinComments && isNotableOrganization(item.organization, notable);
    })
    .sort(
      (left, right) =>
        right.comments - left.comments ||
        Date.parse(right.published) - Date.parse(left.published) ||
        left.title.localeCompare(right.title)
    )
    .slice(0, maxCandidates);
}

export async function fetchDailyPapers(source, fetchImpl, redact) {
  const page = await fetchImpl(source.api_url, { accept: 'application/json', redact });
  return parseDailyPapers(page.text);
}
