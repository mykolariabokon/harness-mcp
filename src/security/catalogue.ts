import type { CheckKind, GrepCheck, DelegatedCheck, Severity } from './types.js';

/**
 * A catalogue of security rules for the JavaScript/TypeScript web stack, offered
 * for import into a project's harness.
 *
 * Offered, not applied. Importing queues each rule as a proposal like everything
 * else — a rule nobody approved does not govern anything, and a security layer
 * that switches itself on is exactly the kind of thing people disable wholesale.
 *
 * Deliberately five, not fifty. Five rules that provably catch their violation and
 * provably stay quiet on correct code are worth more than a wall of patterns
 * nobody trusts: the second false alarm is when a rule starts being ignored, and
 * the third is when the whole layer is.
 *
 * Three are `grep` and the harness proves them alone. Two need evidence it cannot
 * produce and say so — they are here because leaving out the two most valuable
 * rules to keep the demo tidy would misrepresent what this layer is for.
 */
export interface CatalogueRule {
  key: string;
  title: string;
  rationale: string;
  severity: Severity;
  check_kind: CheckKind;
  check: GrepCheck | DelegatedCheck;
  applies_to: string;
}

export const SECURITY_CATALOGUE: CatalogueRule[] = [
  {
    key: 'sec-sql-concat',
    title: 'No SQL built by string concatenation',
    rationale:
      'A value interpolated into SQL is executed as SQL. One unescaped quote in user input and the query ' +
      'becomes whatever the caller wanted. Parameterised queries make that structurally impossible.',
    severity: 'critical',
    check_kind: 'grep',
    check: {
      // Interpolation inside a template literal, but only where the line also
      // looks like SQL. Without `near` this fires on every template string in the
      // codebase, and a rule that fires on everything gets switched off by Friday.
      pattern: '\\$\\{',
      near: '\\b(SELECT|INSERT|INTO|UPDATE|DELETE|WHERE|FROM|JOIN)\\b',
      forbidden: true,
    },
    applies_to: 'src/**/*.{ts,js}',
  },
  {
    key: 'sec-no-secrets',
    title: 'No secrets in source',
    rationale:
      'A key in the repository is a key in every clone, every fork and every backup, and rotating it means ' +
      'finding everyone who has one. In client code it also ships to the browser, where anyone can read it.',
    severity: 'critical',
    check_kind: 'grep',
    check: {
      // Shapes that are unambiguous on sight: provider-prefixed keys and PEM
      // blocks. Deliberately not "any long string" — that is how a secret scanner
      // earns its reputation for noise.
      pattern:
        '(sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)',
      forbidden: true,
    },
    applies_to: 'src/**/*.{ts,tsx,js,jsx}',
  },
  {
    key: 'sec-no-internal-errors',
    title: 'No internal errors in responses',
    rationale:
      'A stack trace or a database message tells an attacker the framework, the file layout and often the ' +
      'schema. It is free reconnaissance, handed over by the error path nobody tested.',
    severity: 'high',
    check_kind: 'grep',
    check: {
      // The error VALUE reaching a response body. The `[^)"'\`]*` is what keeps
      // this usable: it cannot cross a quote, so `json({ message: "Internal
      // error" })` does not match while `json(err)` and `json({ e: err.message })`
      // do. Without it the word "error" inside any human-readable string would
      // trip the rule, and a rule that fires on polite error messages is a rule
      // somebody deletes. Logging the error is untouched — only returning it matches.
      pattern: '\\.(json|send)\\s*\\(\\s*[^)"\'`]*\\b(err|error|e)\\b\\s*[.,)]',
      forbidden: true,
    },
    applies_to: 'src/**/*.{ts,js}',
  },
  {
    key: 'sec-input-validated-server-side',
    title: 'Input is validated on the server',
    rationale:
      'Client-side validation is a convenience for honest users; it is one devtools panel away from being ' +
      'skipped. Whatever the server does not check, it accepts.',
    severity: 'high',
    check_kind: 'structural',
    check: {
      question:
        'Does every request handler validate its input — body, query and params — before that input reaches ' +
        'business logic or a query, rather than relying on validation in the client?',
      needs:
        'a call graph showing what each handler reaches, or a reading of every handler in the governed paths',
    },
    applies_to: 'src/**/api/**',
  },
  {
    key: 'sec-object-level-authorization',
    title: 'A user can only reach their own records',
    rationale:
      'The commonest serious web flaw: the handler checks that you are logged in, then fetches whatever id ' +
      'you asked for. Being authenticated is not the same as being entitled to this row.',
    severity: 'critical',
    // Deliberately runtime rather than structural. Proving statically that a query
    // filters by owner needs real semantic analysis and would be guesswork; two
    // accounts and one request settle it in seconds and leave no doubt.
    check_kind: 'runtime',
    check: {
      question:
        'Signed in as user A, can a request for a resource that belongs to user B be made to succeed by ' +
        'changing only the identifier?',
      needs:
        'a running instance, two accounts, and any way to drive authenticated requests — a browser session, ' +
        'an HTTP client, a scripted flow',
    },
    applies_to: 'src/**/api/**',
  },
];
