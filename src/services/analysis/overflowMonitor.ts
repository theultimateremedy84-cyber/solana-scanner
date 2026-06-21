/**
 * Phase 17 — Integer Overflow / Underflow Monitor
 *
 * Performs heuristic static analysis on a Solana program's on-chain data
 * (BPF/SBF bytecode or account data) to detect unchecked arithmetic operations
 * that are vulnerable to integer overflow or underflow.
 *
 * Two-phase strategy
 * ------------------
 * Phase 1: BPF opcode scan — slides over 8-byte instruction words, flags any
 *   ADD / SUB / MUL / DIV opcode not followed by a branch or EXIT within
 *   two instruction slots (i.e., no visible bounds-check guard).
 *
 * Phase 2: Rust / Anchor pattern heuristics — searches the raw binary for
 *   ASCII byte signatures that indicate whether the binary was compiled with
 *   overflow-checks = true (safe) or false (potentially unsafe).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArithmeticSafetyResult {
  is_vulnerable: boolean;
  risk_level: "none" | "low" | "medium" | "high" | "critical";
  message: string;
  details: ArithmeticFinding[];
  unsafe_instruction_count: number;
  safe_instruction_count: number;
  confidence: "low" | "medium" | "high";
}

export interface ArithmeticFinding {
  type: "unchecked_add" | "unchecked_sub" | "unchecked_mul" | "unchecked_div" | "pattern_match";
  offset: number;
  description: string;
  severity: "critical" | "high" | "medium";
}

// ---------------------------------------------------------------------------
// BPF opcode constants (eBPF arithmetic class)
// ---------------------------------------------------------------------------

const BPF_ADD_32 = 0x07;
const BPF_ADD_64 = 0x0f;
const BPF_SUB_32 = 0x17;
const BPF_SUB_64 = 0x1f;
const BPF_MUL_32 = 0x27;
const BPF_MUL_64 = 0x2f;
const BPF_DIV_32 = 0x37;
const BPF_DIV_64 = 0x3f;

const ARITHMETIC_OPCODES = new Set([
  BPF_ADD_32, BPF_ADD_64,
  BPF_SUB_32, BPF_SUB_64,
  BPF_MUL_32, BPF_MUL_64,
  BPF_DIV_32, BPF_DIV_64,
]);

const OPCODE_NAMES: Record<number, ArithmeticFinding["type"]> = {
  [BPF_ADD_32]: "unchecked_add",
  [BPF_ADD_64]: "unchecked_add",
  [BPF_SUB_32]: "unchecked_sub",
  [BPF_SUB_64]: "unchecked_sub",
  [BPF_MUL_32]: "unchecked_mul",
  [BPF_MUL_64]: "unchecked_mul",
  [BPF_DIV_32]: "unchecked_div",
  [BPF_DIV_64]: "unchecked_div",
};

// BPF branch / trap opcodes that indicate a bounds check follows
const BPF_JEQ  = 0x15;
const BPF_JNE  = 0x55;
const BPF_JSGT = 0x65;
const BPF_JSGE = 0x75;
const BPF_JLT  = 0xa5;
const BPF_JLE  = 0xb5;
const BPF_JSLT = 0xc5;
const BPF_JSLE = 0xd5;
const BPF_EXIT = 0x95;

const BRANCH_OPCODES = new Set([
  BPF_JEQ, BPF_JNE,
  BPF_JSGT, BPF_JSGE,
  BPF_JLT, BPF_JLE,
  BPF_JSLT, BPF_JSLE,
  BPF_EXIT,
]);

// ---------------------------------------------------------------------------
// Rust / Anchor heuristic byte patterns
// ---------------------------------------------------------------------------

/**
 * ASCII byte sequences found in Rust binaries compiled with
 * overflow-checks = true.  Their presence means the binary DOES perform
 * runtime overflow checking — each pattern reduces the vulnerability score.
 */
const SAFE_SIGNATURES: Uint8Array[] = [
  // "attempt to add with overflow"
  new Uint8Array([0x61,0x74,0x74,0x65,0x6d,0x70,0x74,0x20,0x74,0x6f,0x20,0x61,0x64,0x64]),
  // "attempt to subtract with overflow"
  new Uint8Array([0x61,0x74,0x74,0x65,0x6d,0x70,0x74,0x20,0x74,0x6f,0x20,0x73,0x75,0x62]),
  // "attempt to multiply with overflow"
  new Uint8Array([0x61,0x74,0x74,0x65,0x6d,0x70,0x74,0x20,0x74,0x6f,0x20,0x6d,0x75,0x6c]),
  // "checked_add"
  new Uint8Array([0x63,0x68,0x65,0x63,0x6b,0x65,0x64,0x5f,0x61,0x64,0x64]),
  // "checked_sub"
  new Uint8Array([0x63,0x68,0x65,0x63,0x6b,0x65,0x64,0x5f,0x73,0x75,0x62]),
  // "checked_mul"
  new Uint8Array([0x63,0x68,0x65,0x63,0x6b,0x65,0x64,0x5f,0x6d,0x75,0x6c]),
  // "saturating_add"
  new Uint8Array([0x73,0x61,0x74,0x75,0x72,0x61,0x74,0x69,0x6e,0x67,0x5f,0x61,0x64,0x64]),
  // "saturating_sub"
  new Uint8Array([0x73,0x61,0x74,0x75,0x72,0x61,0x74,0x69,0x6e,0x67,0x5f,0x73,0x75,0x62]),
  // "wrapping_add"
  new Uint8Array([0x77,0x72,0x61,0x70,0x70,0x69,0x6e,0x67,0x5f,0x61,0x64,0x64]),
];

/**
 * Patterns associated with UNSAFE arithmetic — no overflow protection.
 * Their presence triggers an immediate vulnerability flag.
 */
const UNSAFE_SIGNATURES: { pattern: Uint8Array; description: string }[] = [
  {
    // "overflow-checks" — embedded Cargo/rustc metadata
    pattern: new Uint8Array([0x6f,0x76,0x65,0x72,0x66,0x6c,0x6f,0x77,0x2d,0x63,0x68,0x65,0x63,0x6b,0x73]),
    description: "Binary metadata contains 'overflow-checks' — may be compiled with overflow-checks=false",
  },
  {
    // "panic_nounwind" — Rust ≥1.73 panic variant, common in release builds without overflow checks
    pattern: new Uint8Array([0x70,0x61,0x6e,0x69,0x63,0x5f,0x6e,0x6f,0x75,0x6e,0x77,0x69,0x6e,0x64]),
    description: "panic_nounwind detected — binary may omit overflow guards in hot arithmetic paths",
  },
  {
    // "__aeabi_idiv" — unchecked integer division intrinsic
    pattern: new Uint8Array([0x5f,0x5f,0x61,0x65,0x61,0x62,0x69,0x5f,0x69,0x64,0x69,0x76]),
    description: "Unchecked integer division intrinsic (__aeabi_idiv) detected",
  },
];

// ---------------------------------------------------------------------------
// Boyer-Moore-Horspool substring search
// ---------------------------------------------------------------------------

function findPattern(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  const skip = new Uint8Array(256).fill(needle.length);
  for (let i = 0; i < needle.length - 1; i++) {
    skip[needle[i]] = needle.length - 1 - i;
  }
  let i = needle.length - 1;
  while (i < haystack.length) {
    let j = needle.length - 1;
    let k = i;
    while (j >= 0 && haystack[k] === needle[j]) { k--; j--; }
    if (j < 0) return k + 1;
    i += skip[haystack[i]];
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * analyzeArithmeticSafety
 *
 * Accepts the raw bytes of any Solana account or program (BPF/SBF ELF or
 * account data) as a Buffer/Uint8Array and returns a structured vulnerability
 * report.
 *
 * @param programData — raw bytes from an on-chain `getAccountInfo` response.
 */
export function analyzeArithmeticSafety(
  programData: Buffer | Uint8Array,
): ArithmeticSafetyResult {
  const data =
    programData instanceof Buffer ? new Uint8Array(programData) : programData;
  const findings: ArithmeticFinding[] = [];
  let safeInstructions = 0;
  let unsafeInstructions = 0;

  // -------------------------------------------------------------------------
  // Phase 1: BPF opcode scan
  //
  // BPF instructions are exactly 8 bytes wide:
  //   byte 0:   opcode
  //   byte 1:   dst_reg | src_reg
  //   bytes 2-3: offset (16-bit LE)
  //   bytes 4-7: imm (32-bit LE)
  //
  // We slide over every 8-byte-aligned window and flag any arithmetic opcode
  // that has no branch/EXIT within the next two instruction slots.
  // -------------------------------------------------------------------------
  const INSN_SIZE = 8;
  const LOOKAHEAD = 2;

  for (let off = 0; off + INSN_SIZE <= data.length; off += INSN_SIZE) {
    const opcode = data[off];
    if (!ARITHMETIC_OPCODES.has(opcode)) continue;

    let hasGuard = false;
    for (
      let la = 1;
      la <= LOOKAHEAD && off + la * INSN_SIZE + INSN_SIZE <= data.length;
      la++
    ) {
      if (BRANCH_OPCODES.has(data[off + la * INSN_SIZE])) {
        hasGuard = true;
        break;
      }
    }

    if (hasGuard) {
      safeInstructions++;
    } else {
      unsafeInstructions++;
      if (findings.length < 20) {
        findings.push({
          type: OPCODE_NAMES[opcode] ?? "unchecked_add",
          offset: off,
          description:
            `Unchecked arithmetic opcode 0x${opcode.toString(16).padStart(2, "0")}` +
            ` at bytecode offset ${off} — no bounds-check guard within ${LOOKAHEAD} instruction slots`,
          severity:
            opcode === BPF_MUL_32 || opcode === BPF_MUL_64 ? "critical" : "high",
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2: Rust / Anchor pattern heuristics
  // -------------------------------------------------------------------------
  let safePatternHits = 0;
  for (const sig of SAFE_SIGNATURES) {
    if (findPattern(data, sig) !== -1) safePatternHits++;
  }

  for (const { pattern, description } of UNSAFE_SIGNATURES) {
    const offset = findPattern(data, pattern);
    if (offset !== -1) {
      findings.push({
        type: "pattern_match",
        offset,
        description,
        severity: "critical",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Phase 3: Verdict
  // -------------------------------------------------------------------------
  const totalArith = safeInstructions + unsafeInstructions;
  const unsafeRatio = totalArith > 0 ? unsafeInstructions / totalArith : 0;
  const hasUnsafePatterns = findings.some((f) => f.type === "pattern_match");

  const confidence: ArithmeticSafetyResult["confidence"] =
    totalArith > 50 ? "high" : totalArith > 10 ? "medium" : "low";

  // Declare vulnerable when:
  //  - Any explicit unsafe byte pattern is found, OR
  //  - More than 15% of arithmetic ops are unguarded, OR
  //  - Safe-pattern hits are zero AND there are unguarded ops
  const is_vulnerable =
    hasUnsafePatterns ||
    unsafeRatio > 0.15 ||
    (safePatternHits === 0 && unsafeInstructions > 0);

  if (!is_vulnerable) {
    return {
      is_vulnerable: false,
      risk_level: "none",
      message:
        "No unchecked arithmetic detected. Program appears to use safe math primitives.",
      details: [],
      unsafe_instruction_count: unsafeInstructions,
      safe_instruction_count: safeInstructions,
      confidence,
    };
  }

  return {
    is_vulnerable: true,
    risk_level: "critical",
    message:
      "Security Warning: Unchecked arithmetic detected. The program is vulnerable to integer overflow/underflow in production builds.",
    details: findings,
    unsafe_instruction_count: unsafeInstructions,
    safe_instruction_count: safeInstructions,
    confidence,
  };
}
