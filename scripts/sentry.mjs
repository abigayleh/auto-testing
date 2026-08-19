// Sentry read API. Polling only — this runner never writes to Sentry.
const API = 'https://sentry.io/api/0';

const auth = () => {
  const token = process.env.SENTRY_AUTH_TOKEN;
  if (!token) throw new Error('SENTRY_AUTH_TOKEN is not set');
  return { Authorization: `Bearer ${token}` };
};

async function get(path) {
  const res = await fetch(`${API}${path}`, { headers: auth() });
  if (!res.ok) {
    // A 401 here means an expired token, which must be loud: a silent skip is
    // indistinguishable from "no production errors".
    throw new Error(`Sentry ${res.status} ${res.statusText} on ${path}`);
  }
  return res.json();
}

// Unresolved issues first seen within the window, newest first.
export async function listNewIssues({ org, project, hours = 24 }) {
  const query = encodeURIComponent(`is:unresolved firstSeen:-${hours}h`);
  const issues = await get(`/projects/${org}/${project}/issues/?query=${query}&statsPeriod=&limit=25`);
  return issues.map((i) => ({
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit,
    count: Number(i.count ?? 0),
    userCount: Number(i.userCount ?? 0),
    permalink: i.permalink,
    firstSeen: i.firstSeen,
  }));
}

export async function getIssue(issueId) {
  const i = await get(`/issues/${issueId}/`);
  return {
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    culprit: i.culprit,
    count: Number(i.count ?? 0),
    userCount: Number(i.userCount ?? 0),
    permalink: i.permalink,
    firstSeen: i.firstSeen,
  };
}

// The latest event carries the stack trace. Without in-app frames that resolve
// to a real file the fix step has nothing to work from, so we surface both.
export async function getLatestEvent(issueId) {
  const event = await get(`/issues/${issueId}/events/latest/`);
  const exception = (event.entries || []).find((e) => e.type === 'exception');
  const values = exception?.data?.values ?? [];
  const frames = values.flatMap((v) => v.stacktrace?.frames ?? []);

  return {
    eventId: event.eventID,
    message: event.message || event.title,
    platform: event.platform,
    release: event.release?.version ?? null,
    tags: Object.fromEntries((event.tags || []).map((t) => [t.key, t.value])),
    frames: frames.map((f) => ({
      filename: f.filename,
      absPath: f.absPath,
      function: f.function,
      lineNo: f.lineNo,
      inApp: Boolean(f.inApp),
      context: f.context ?? [],
    })),
  };
}

// A frame is usable when it names a real file and a line. Minified bundle
// offsets fail this, which is the gate that keeps mobile out until source maps
// resolve.
export function resolvableFrames(frames) {
  return frames.filter(
    (f) => f.inApp && f.lineNo && f.filename && !/^https?:\/\//.test(f.filename) && !/\.min\.js$/.test(f.filename)
  );
}

export function formatStackTrace(event) {
  const lines = [`${event.message}`, ''];
  for (const f of event.frames.slice(-25)) {
    lines.push(`${f.inApp ? '>' : ' '} ${f.filename}:${f.lineNo ?? '?'} in ${f.function ?? '<anonymous>'}`);
    for (const [ln, src] of f.context ?? []) lines.push(`      ${ln}| ${src}`);
  }
  return lines.join('\n');
}
