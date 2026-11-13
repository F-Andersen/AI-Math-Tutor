// Deterministic algebra engine used as ground truth by the AI tutor.
// Parses single-variable polynomial equations (degree <= 2 is solvable),
// compares two equations step-by-step and classifies the transformation.
// Exact rational arithmetic (BigInt) so "7/2" never becomes 3.4999999.

// ---------- Fractions ----------
const babs = (a) => (a < 0n ? -a : a);
const gcd = (a, b) => {
  a = babs(a); b = babs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
};

export class Frac {
  constructor(n, d = 1n) {
    if (d === 0n) throw new MathError("Division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    this.n = n / g;
    this.d = d / g;
  }
  static of(v) {
    if (v instanceof Frac) return v;
    if (typeof v === "bigint") return new Frac(v);
    const s = String(v);
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new MathError(`Not a number: ${s}`);
    const [int, dec = ""] = s.split(".");
    return new Frac(BigInt(int + dec), 10n ** BigInt(dec.length));
  }
  add(o) { return new Frac(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Frac(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Frac(this.n * o.n, this.d * o.d); }
  div(o) { return new Frac(this.n * o.d, this.d * o.n); }
  neg() { return new Frac(-this.n, this.d); }
  isZero() { return this.n === 0n; }
  eq(o) { return this.n === o.n && this.d === o.d; }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString() { return this.d === 1n ? `${this.n}` : `${this.n}/${this.d}`; }
}

export class MathError extends Error {}

// ---------- Polynomials: Map<degree, Frac> ----------
class Poly {
  constructor(terms = new Map()) {
    this.t = new Map();
    for (const [k, v] of terms) if (!v.isZero()) this.t.set(k, v);
  }
  static const(c) { return new Poly(new Map([[0, Frac.of(c)]])); }
  static variable() { return new Poly(new Map([[1, new Frac(1n)]])); }
  degree() { return this.t.size ? Math.max(...this.t.keys()) : -Infinity; }
  coef(k) { return this.t.get(k) ?? new Frac(0n); }
  isConst() { return this.degree() <= 0; }
  add(o) {
    const m = new Map(this.t);
    for (const [k, v] of o.t) m.set(k, (m.get(k) ?? new Frac(0n)).add(v));
    return new Poly(m);
  }
  neg() { return new Poly(new Map([...this.t].map(([k, v]) => [k, v.neg()]))); }
  sub(o) { return this.add(o.neg()); }
  mul(o) {
    const m = new Map();
    for (const [a, x] of this.t)
      for (const [b, y] of o.t) m.set(a + b, (m.get(a + b) ?? new Frac(0n)).add(x.mul(y)));
    return new Poly(m);
  }
  scale(f) { return new Poly(new Map([...this.t].map(([k, v]) => [k, v.mul(f)]))); }
  eq(o) { return this.sub(o).t.size === 0; }
  evalAt(x) {
    let r = new Frac(0n);
    for (const [k, v] of this.t) {
      let p = new Frac(1n);
      for (let i = 0; i < k; i++) p = p.mul(x);
      r = r.add(v.mul(p));
    }
    return r;
  }
  format(v = "x") {
    if (!this.t.size) return "0";
    const keys = [...this.t.keys()].sort((a, b) => b - a);
    let out = "";
    keys.forEach((k, i) => {
      const c = this.t.get(k);
      const negative = c.n < 0n;
      const absC = negative ? c.neg() : c;
      const cs = absC.toString();
      const body = k === 0 ? cs : `${cs === "1" ? "" : cs.includes("/") ? `(${cs})` : cs}${v}${k > 1 ? `^${k}` : ""}`;
      out += i === 0 ? (negative ? `-${body}` : body) : negative ? ` - ${body}` : ` + ${body}`;
    });
    return out;
  }
}

// ---------- Tokenizer & parser ----------
function normalizeInput(s) {
  return String(s)
    .replace(/[−–—]/g, "-")
    .replace(/[×·∙⋅]/g, "*")
    .replace(/÷/g, "/")
    .replace(/²/g, "^2")
    .replace(/,/g, ".")
    .toLowerCase() // phone keyboards capitalise: "X = 7" is the same variable as "x"
    .trim();
}

function tokenize(s) {
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ type: "num", value: s.slice(i, j) });
      i = j; continue;
    }
    if (/[a-zA-Z]/.test(c)) { tokens.push({ type: "var", value: c }); i++; continue; }
    if ("+-*/^()=".includes(c)) { tokens.push({ type: c }); i++; continue; }
    throw new MathError(`Unexpected character "${c}"`);
  }
  return tokens;
}

function parseExpression(tokens, ctx) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    const t = tokens[pos];
    if (!t || (type && t.type !== type)) throw new MathError(`Expected ${type ?? "token"}`);
    pos++;
    return t;
  };
  function expr() {
    let left = term();
    while (peek() && (peek().type === "+" || peek().type === "-")) {
      const op = take().type;
      const right = term();
      left = op === "+" ? left.add(right) : left.sub(right);
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t && (t.type === "*" || t.type === "/")) {
        take();
        const right = unary();
        if (t.type === "*") left = left.mul(right);
        else {
          if (!right.isConst()) throw new MathError("Variable in a denominator is not supported");
          left = left.scale(new Frac(1n).div(right.coef(0)));
        }
      } else if (t && (t.type === "var" || t.type === "(")) {
        left = left.mul(power()); // implicit multiplication: 3x, 3(x+4), (x+1)(x-1)
      } else return left;
    }
  }
  function unary() {
    const t = peek();
    if (t && t.type === "-") { take(); return unary().neg(); }
    if (t && t.type === "+") { take(); return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() && peek().type === "^") {
      take();
      const e = unary();
      if (!e.isConst()) throw new MathError("Exponent must be a number");
      const k = e.coef(0);
      if (k.d !== 1n || k.n < 0n || k.n > 6n) throw new MathError("Exponent must be a whole number 0–6");
      let r = Poly.const(1);
      for (let i = 0n; i < k.n; i++) r = r.mul(base);
      return r;
    }
    return base;
  }
  function primary() {
    const t = take();
    if (t.type === "num") return Poly.const(Frac.of(t.value));
    if (t.type === "var") {
      if (ctx.variable && ctx.variable !== t.value)
        throw new MathError(`Only one variable is supported (found ${ctx.variable} and ${t.value})`);
      ctx.variable = t.value;
      return Poly.variable();
    }
    if (t.type === "(") { const e = expr(); take(")"); return e; }
    throw new MathError(`Unexpected "${t.type}"`);
  }
  const result = expr();
  if (pos !== tokens.length) throw new MathError(`Unexpected "${tokens[pos].type}"`);
  return result;
}

export function parseEquation(input, ctx = {}) {
  const s = normalizeInput(input);
  const parts = s.split("=");
  if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim())
    throw new MathError(`"${input}" is not an equation with exactly one "="`);
  const lhs = parseExpression(tokenize(parts[0]), ctx);
  const rhs = parseExpression(tokenize(parts[1]), ctx);
  return { lhs, rhs, variable: ctx.variable ?? "x", raw: input };
}

// ---------- Solving ----------
function solvePoly(p) {
  const deg = p.degree();
  if (deg === -Infinity) return { kind: "all_real_numbers", values: [] };
  if (deg === 0) return { kind: "no_solution", values: [] };
  if (deg === 1) {
    const x = p.coef(0).neg().div(p.coef(1));
    return { kind: "finite", values: [x] };
  }
  if (deg === 2) {
    const a = p.coef(2), b = p.coef(1), c = p.coef(0);
    const disc = b.mul(b).sub(new Frac(4n).mul(a).mul(c));
    if (disc.n < 0n) return { kind: "no_real_solution", values: [] };
    if (disc.isZero()) return { kind: "finite", values: [b.neg().div(new Frac(2n).mul(a))] };
    // exact if discriminant is a perfect square of a rational
    const sq = (v) => { const r = BigInt(Math.round(Math.sqrt(Number(v)))); return r * r === v ? r : null; };
    const rn = sq(disc.n), rd = sq(disc.d);
    if (rn !== null && rd !== null) {
      const r = new Frac(rn, rd), two_a = new Frac(2n).mul(a);
      const v = [b.neg().sub(r).div(two_a), b.neg().add(r).div(two_a)];
      return { kind: "finite", values: v.sort((x, y) => x.toNumber() - y.toNumber()) };
    }
    const d = Math.sqrt(disc.toNumber()), A = a.toNumber(), B = b.toNumber();
    return { kind: "finite", values: [(-B - d) / (2 * A), (-B + d) / (2 * A)].sort((x, y) => x - y) };
  }
  return { kind: "unsupported_degree", values: [] };
}

const fmtVal = (v) => (v instanceof Frac ? v.toString() : Number(v.toFixed(6)).toString());
const numVal = (v) => (v instanceof Frac ? v.toNumber() : v);

function describe(eq) {
  const p = eq.lhs.sub(eq.rhs);
  const sol = solvePoly(p);
  const v = eq.variable;
  return {
    input: eq.raw,
    simplified: `${eq.lhs.format(v)} = ${eq.rhs.format(v)}`,
    degree: Math.max(eq.lhs.degree(), eq.rhs.degree(), 0),
    solution_kind: sol.kind,
    solutions: sol.values.map((x) => `${v} = ${fmtVal(x)}`),
    _sol: sol,
  };
}

const isEmpty = (s) => s.kind === "no_solution" || s.kind === "no_real_solution";

function sameSolutionSet(a, b) {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind !== "finite") return true; // both "all real numbers"
  if (a.values.length !== b.values.length) return false;
  return a.values.every((x, i) => Math.abs(numVal(x) - numVal(b.values[i])) < 1e-9);
}

/** True when q = k·p for a non-zero constant k: the equations p = 0 and q = 0 are then equivalent at any degree. */
function proportional(p, q) {
  if (!p.t.size || !q.t.size) return p.t.size === q.t.size;
  const k = p.degree();
  if (q.degree() !== k) return false;
  return p.scale(q.coef(k).div(p.coef(k))).eq(q);
}

const strip = ({ _sol, ...rest }) => rest;

/** Solve / normalise a single equation. */
export function analyzeEquation(input) {
  return strip(describe(parseEquation(input)));
}

/**
 * Compare a student's new line against the previous line.
 * Returns whether the step preserves the solution set and, side by side,
 * what changed — so the tutor can locate *where* the reasoning broke.
 */
export function checkStep(previous, next) {
  const ctx = {};
  const A = parseEquation(previous, ctx);
  const B = parseEquation(next, ctx);
  const v = ctx.variable ?? "x";
  const da = describe(A), db = describe(B);
  let equivalent;
  if (proportional(A.lhs.sub(A.rhs), B.lhs.sub(B.rhs))) equivalent = true;
  else if (da._sol.kind === "unsupported_degree" || db._sol.kind === "unsupported_degree")
    // Never guess: a correct step must not be reported as an error.
    throw new MathError("This step involves a power above 2 and cannot be verified automatically; judge it yourself and say so if unsure");
  else equivalent = sameSolutionSet(da._sol, db._sol);

  const lhsChange = B.lhs.sub(A.lhs), rhsChange = B.rhs.sub(A.rhs);
  let transformation;
  if (A.lhs.eq(B.lhs) && A.rhs.eq(B.rhs)) transformation = "rewrite_only (each side has the same value as before; e.g. expanding or collecting like terms correctly)";
  else if (A.lhs.eq(B.rhs) && A.rhs.eq(B.lhs)) transformation = "sides_swapped";
  else if (lhsChange.eq(rhsChange)) transformation = `same_quantity_added_to_both_sides (added ${lhsChange.format(v)})`;
  else {
    const scaleOf = (o, n) => {
      if (!o.t.size) return null;
      const [k, c] = [...o.t][0];
      const f = n.coef(k).div(c);
      return o.scale(f).eq(n) && !f.isZero() ? f : null;
    };
    const fl = scaleOf(A.lhs, B.lhs), fr = scaleOf(A.rhs, B.rhs);
    if (fl && fr && fl.eq(fr)) transformation = `both_sides_multiplied_by ${fl}`;
    else if (equivalent) transformation = "equivalent_by_combined_operations";
    else transformation = "INVALID: sides were changed by different amounts";
  }

  const sideReport = (name, before, after) => ({
    side: name,
    before_simplified: before.format(v),
    after_simplified: after.format(v),
    value_preserved: before.eq(after),
    change: after.sub(before).format(v),
  });

  return {
    previous: strip(da),
    student: strip(db),
    equivalent,
    transformation,
    sides: [sideReport("left", A.lhs, B.lhs), sideReport("right", A.rhs, B.rhs)],
    note: equivalent
      ? "The step keeps the same solution set."
      : "The step CHANGES the solution set — there is an error in this step. Use the side-by-side report to locate it.",
  };
}

/** Substitute a value into an equation and report both sides. */
export function checkAnswer(equation, value) {
  const eq = parseEquation(equation);
  const raw = normalizeInput(String(value)).replace(/^[a-zA-Z]\s*=\s*/, "");
  const ctx = {};
  const valPoly = parseExpression(tokenize(raw), ctx);
  if (!valPoly.isConst()) throw new MathError(`"${value}" is not a number`);
  const x = valPoly.coef(0);
  const l = eq.lhs.evalAt(x), r = eq.rhs.evalAt(x);
  return {
    equation,
    substituted: `${eq.variable} = ${x}`,
    left_value: l.toString(),
    right_value: r.toString(),
    satisfies_equation: l.eq(r),
    true_solutions: describe(eq).solutions,
  };
}
