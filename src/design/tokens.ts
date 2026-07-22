/**
 * Design tokens for the mockup renderer.
 *
 * The harness stays vendor-neutral: it keeps a small normalized token set that the
 * visualization can paint with, plus the raw vendor payload untouched. Design MCP
 * is the expected source, but anything able to fill `DesignTokens` works — a
 * mockup either renders as a grey skeleton (no tokens) or in the project's own
 * design system (tokens present).
 */

export interface DesignTokens {
  source: string;
  fetched_at: string;
  colors: {
    bg: string;
    surface: string;
    text: string;
    muted: string;
    border: string;
    accent: string;
    accent_text: string;
  };
  radii: { control: string; card: string; pill: string };
  spacing: { xs: string; sm: string; md: string };
  fonts: { heading: string; body: string; mono: string };
  font_sizes: { label: string; body: string; title: string };
  shadows: { card: string };
  /** The vendor payload exactly as received — never reinterpreted, only carried. */
  raw?: unknown;
}

const FALLBACK: Omit<DesignTokens, 'source' | 'fetched_at' | 'raw'> = {
  colors: {
    bg: '#f8fafc', surface: '#ffffff', text: '#1f2937', muted: '#64748b',
    border: '#e2e8f0', accent: '#2f6f4f', accent_text: '#ffffff',
  },
  radii: { control: '8px', card: '12px', pill: '9999px' },
  spacing: { xs: '4px', sm: '8px', md: '16px' },
  fonts: { heading: 'inherit', body: 'inherit', mono: 'monospace' },
  font_sizes: { label: '12px', body: '14px', title: '18px' },
  shadows: { card: '0 10px 24px rgba(15,23,42,0.06)' },
};

type Dict = Record<string, any>;

/** Take the vendor value when it is a usable string, otherwise the fallback. */
const pick = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value : fallback;

/**
 * Map a Design MCP `get_tokens({category:"all"})` payload onto the normalized set.
 * Anything missing falls back rather than throwing: a partial theme still beats grey.
 */
export function normalizeDesignMcpTokens(payload: unknown, source = 'design-mcp'): DesignTokens {
  const t: Dict = (payload as Dict)?.tokens ?? (payload as Dict) ?? {};
  const colors: Dict = t.colors ?? {};
  const neutral: Dict = colors.neutral ?? {};
  const brand: Dict = colors.brand ?? {};
  const radii: Dict = t.radii ?? {};
  const spacing: Dict = t.spacing ?? {};
  const fonts: Dict = t.fonts ?? {};
  const sizes: Dict = t.font_sizes ?? {};
  const shadows: Dict = t.shadows ?? {};
  // Real design systems keep "the colour of text on a brand surface" in semantic
  // tokens, not in the palette — Design MCP has no colors.white, but does have
  // text.inverse. Read it before falling back.
  const semantic: Dict = t.semantic_tokens?.colors ?? {};
  const inverse = semantic['text.inverse']?.default ?? colors.white;

  return {
    source,
    fetched_at: new Date().toISOString(),
    colors: {
      bg: pick(neutral['50'], FALLBACK.colors.bg),
      surface: pick(neutral['0'], FALLBACK.colors.surface),
      text: pick(neutral['800'], FALLBACK.colors.text),
      muted: pick(neutral['500'], FALLBACK.colors.muted),
      border: pick(neutral['200'], FALLBACK.colors.border),
      accent: pick(brand['500'], FALLBACK.colors.accent),
      accent_text: pick(inverse, FALLBACK.colors.accent_text),
    },
    radii: {
      control: pick(radii.sm, FALLBACK.radii.control),
      card: pick(radii.md ?? radii.lg, FALLBACK.radii.card),
      pill: pick(radii.pill, FALLBACK.radii.pill),
    },
    spacing: {
      xs: pick(spacing['1'], FALLBACK.spacing.xs),
      sm: pick(spacing['2'], FALLBACK.spacing.sm),
      md: pick(spacing['4'], FALLBACK.spacing.md),
    },
    fonts: {
      heading: pick(fonts.heading, FALLBACK.fonts.heading),
      body: pick(fonts.body, FALLBACK.fonts.body),
      mono: pick(fonts.mono, FALLBACK.fonts.mono),
    },
    font_sizes: {
      label: pick(sizes.xs, FALLBACK.font_sizes.label),
      body: pick(sizes.sm, FALLBACK.font_sizes.body),
      title: pick(sizes.lg, FALLBACK.font_sizes.title),
    },
    shadows: { card: pick(shadows.cardMd ?? shadows.cardSm, FALLBACK.shadows.card) },
    raw: payload,
  };
}

/** Accept either an already-normalized set or a raw vendor payload. */
export function coerceTokens(input: unknown, source: string): DesignTokens {
  const candidate = input as Partial<DesignTokens>;
  if (candidate && candidate.colors && candidate.radii && candidate.fonts) {
    return {
      ...FALLBACK,
      ...candidate,
      colors: { ...FALLBACK.colors, ...candidate.colors },
      radii: { ...FALLBACK.radii, ...candidate.radii },
      spacing: { ...FALLBACK.spacing, ...candidate.spacing },
      fonts: { ...FALLBACK.fonts, ...candidate.fonts },
      font_sizes: { ...FALLBACK.font_sizes, ...candidate.font_sizes },
      shadows: { ...FALLBACK.shadows, ...candidate.shadows },
      source: candidate.source ?? source,
      fetched_at: candidate.fetched_at ?? new Date().toISOString(),
    };
  }
  return normalizeDesignMcpTokens(input, source);
}

/** CSS custom properties consumed by the mockup panel. */
export function tokensToCss(t: DesignTokens): string {
  return `
.themed {
  --t-bg: ${t.colors.bg};
  --t-surface: ${t.colors.surface};
  --t-text: ${t.colors.text};
  --t-muted: ${t.colors.muted};
  --t-border: ${t.colors.border};
  --t-accent: ${t.colors.accent};
  --t-accent-text: ${t.colors.accent_text};
  --t-radius-control: ${t.radii.control};
  --t-radius-card: ${t.radii.card};
  --t-radius-pill: ${t.radii.pill};
  --t-space-xs: ${t.spacing.xs};
  --t-space-sm: ${t.spacing.sm};
  --t-space-md: ${t.spacing.md};
  --t-font-heading: ${t.fonts.heading};
  --t-font-body: ${t.fonts.body};
  --t-size-label: ${t.font_sizes.label};
  --t-size-body: ${t.font_sizes.body};
  --t-size-title: ${t.font_sizes.title};
  --t-shadow-card: ${t.shadows.card};
}`.trim();
}

/**
 * Design-system rules worth enforcing mechanically. Everything else imports as
 * prose — a rule the harness cannot check is still a rule the agent must follow.
 */
const KNOWN_CHECKS: Array<{ match: RegExp; glob: string; pattern: string; forbidden: boolean }> = [
  {
    match: /hardcode\s+hex|raw hex/i,
    glob: 'src/**/*.tsx',
    pattern: '(?:bg|color|borderColor)=["\']#[0-9a-fA-F]{3,8}["\']',
    forbidden: true,
  },
  {
    match: /useColorMode\(\)\s*ternar/i,
    glob: 'src/**/*.tsx',
    pattern: 'colorMode\\s*===\\s*["\']dark["\']',
    forbidden: true,
  },
  {
    match: /shadow values not in shadow tokens|token-defined shadows/i,
    glob: 'src/**/*.tsx',
    pattern: 'boxShadow=["\']\\d',
    forbidden: true,
  },
];

export interface ImportedRule {
  rule: string;
  scope: string;
  check: { glob: string; pattern: string; forbidden: boolean } | null;
}

/** Flatten a Design MCP `get_rules` payload into harness design rules. */
export function rulesFromDesignMcp(payload: unknown): ImportedRule[] {
  const p = (payload ?? {}) as Dict;
  const out: ImportedRule[] = [];

  const take = (items: unknown, prefix: string): void => {
    for (const item of Array.isArray(items) ? items : []) {
      const text = typeof item === 'string' ? item : (item as Dict)?.rule;
      if (!text) continue;
      const why = typeof item === 'object' ? (item as Dict).why : null;
      const known = KNOWN_CHECKS.find((k) => k.match.test(String(text)));
      out.push({
        rule: `${prefix}${text}${why ? ` — ${why}` : ''}`,
        scope: 'global',
        check: known ? { glob: known.glob, pattern: known.pattern, forbidden: known.forbidden } : null,
      });
    }
  };

  take(p.mustDo, '');
  take(p.mustNot, '');
  take(p.definitionOfDone, 'Definition of done: ');
  take(p.formRules, 'Forms: ');
  take(p.darkModeStrategy, 'Dark mode: ');
  return out;
}
