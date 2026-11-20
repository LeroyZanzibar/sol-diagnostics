/** Display preferences only. These never change detection, review decisions or stored losses. */
export const issueVisibilityOptions = [
  { key: 'siteOutage', label: 'Site outages', description: 'Zero or near-zero production across the site during qualified daylight.' },
  { key: 'partialSiteOutage', label: 'Partial site outages', description: 'Synchronized outages affecting part of the inverter fleet.' },
  { key: 'equipmentOutage', label: 'Inverter / equipment outages', description: 'Individual equipment that is offline when production is expected.' },
  { key: 'communicationIssue', label: 'Meter communication issues', description: 'Missing or inconsistent revenue-meter readings checked against inverter production.' },
  { key: 'siteTelemetryOutage', label: 'Site telemetry outages', description: 'Missing meter and inverter readings that leave site production unknown.' },
  { key: 'equipmentTelemetryIssue', label: 'Equipment telemetry issues', description: 'Missing equipment readings where the evidence does not establish a physical outage.' },
  { key: 'dataGap', label: 'Other data gaps', description: 'Other missing production readings during expected production intervals.' },
] as const;

export type IssueVisibilityKey = typeof issueVisibilityOptions[number]['key'];
export type IssueVisibility = Record<IssueVisibilityKey, boolean>;
export const defaultIssueVisibility: IssueVisibility = Object.fromEntries(issueVisibilityOptions.map(option => [option.key, true])) as IssueVisibility;

/** Ignore retired saved keys; unreadable preferences and future issue types fail open. */
export function normalizeIssueVisibility(value: unknown): IssueVisibility {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(issueVisibilityOptions.map(({key}) => [key, typeof source[key] === 'boolean' ? source[key] : true])) as IssueVisibility;
}

export function issueVisibilityInputError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Provide issue visibility as a set of on/off preferences.';
  const keys = new Set<string>(issueVisibilityOptions.map(option => option.key));
  for (const [key, enabled] of Object.entries(value)) {
    if (!keys.has(key) && key !== 'siteUnderperformance' && key !== 'inverterUnderperformance') return 'An unsupported issue visibility preference was supplied.';
    if (typeof enabled !== 'boolean') return 'Each issue visibility preference must be true or false.';
  }
  return null;
}

export function issueVisibilityKey(issue: {type: string; equipmentType?: string}): IssueVisibilityKey | null {
  switch (issue.type) {
    case 'Site outage': return 'siteOutage';
    case 'Partial site outage': return 'partialSiteOutage';
    case 'Equipment outage': return 'equipmentOutage';
    case 'Site telemetry outage': return 'siteTelemetryOutage';
    case 'Equipment telemetry issue': return 'equipmentTelemetryIssue';
    case 'Data gap': return 'dataGap';
    case 'Communication issue': return 'communicationIssue';
    default: return null;
  }
}

export function isIssueVisible(issue: {type: string; equipmentType?: string}, preferences: IssueVisibility): boolean {
  // A retired known detector is not an unknown future type. Never revive saved findings.
  if (issue.type === 'Underperformance') return false;
  const key = issueVisibilityKey(issue);
  return key === null || preferences[key] !== false;
}
