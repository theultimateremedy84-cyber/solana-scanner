/**
 * Phase 16 — 'Rent-Exemption & Account Eviction' Detector
 * ---------------------------------------------------------------
 * Detects accounts that are NOT rent-exempt (i.e., their lamport
 * balance is below the minimum required to persist on-chain).
 *
 * On Solana, accounts that fall below the rent-exempt threshold
 * can be garbage-collected (evicted) by the runtime. An evicted
 * account loses all its state, which opens the door for an attacker
 * to re-create that account with malicious data — a form of
 * 'state hijacking via account resurrection'.
 *
 * Strategy
 *   1. For each account identified in recent transactions, the
 *      caller fetches:
 *        - account.lamports     — current on-chain balance
 *        - account.dataLength   — byte length of account data
 *        - account.owner        — program that owns the account
 *        - requiredMinimum      — result of
 *            getMinimumBalanceForRentExemption(dataLength)
 *   2. This module skips System Program accounts — they are
 *      native to the runtime and are never subject to eviction.
 *   3. For all remaining accounts, lamports vs requiredMinimum
 *      is compared. Any shortfall is flagged.
 *
 * Pure computation module — all RPC calls happen in scan.functions.ts.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The Solana System Program address.
 * Accounts owned by the System Program (e.g. wallet accounts, fee payers)
 * are maintained by the runtime itself and are never subject to rent
 * eviction, so they must be excluded from the rent-exempt check.
 */
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountRentInfo {
  /** Base58 public key of the account. */
  address: string;
  /** Current on-chain balance in lamports. */
  lamports: number;
  /** Length of the account's data field in bytes. */
  dataLength: number;
  /**
   * Program that owns this account (base58).
   * Accounts owned by the System Program ("11111111111111111111111111111111")
   * are skipped — they are native runtime accounts and do not require a
   * rent-exempt reserve.
   */
  owner: string;
  /** Minimum balance for rent exemption returned by the RPC. */
  requiredMinimum: number;
}

export interface RentExemptViolation {
  /** Base58 public key of the at-risk account. */
  address: string;
  /** Current on-chain balance in lamports. */
  lamports: number;
  /** Minimum lamports required for rent exemption. */
  requiredMinimum: number;
  /** How many lamports short of the rent-exempt threshold. */
  deficit: number;
}

export interface RentMonitorResult {
  /** TRUE when at least one non-system account is below its rent-exempt minimum. */
  has_non_rent_exempt_accounts: boolean;
  /** All accounts that failed the rent-exempt check. */
  violations: RentExemptViolation[];
  /** Total number of accounts that were evaluated (excluding system accounts). */
  checkedCount: number;
  /**
   * Human-readable summary stored in the UI tooltip / scan detail.
   * On violations: pipe-delimited list of address + deficit.
   * On clean: confirmation that all accounts passed.
   */
  details: string;
}

// ---------------------------------------------------------------------------
// Core analysis function
// ---------------------------------------------------------------------------

/**
 * Given a list of pre-fetched account rent snapshots, flag every account
 * whose current lamport balance is below the rent-exempt minimum.
 *
 * System Program accounts (owner === SYSTEM_PROGRAM_ID) are always skipped —
 * they are runtime-managed and do not require a rent-exempt reserve.
 *
 * Callers (scan.functions.ts) are responsible for:
 *   1. Fetching account infos via getAccountInfo (lamports + data length + owner).
 *   2. Calling getMinimumBalanceForRentExemption for each unique data length.
 *   3. Assembling the AccountRentInfo list and passing it here.
 */
export function analyzeRentExemption(
  accounts: AccountRentInfo[],
): RentMonitorResult {
  const violations: RentExemptViolation[] = [];
  let checkedCount = 0;

  for (const account of accounts) {
    // Guard: skip System Program accounts — they are native runtime accounts
    // (wallet addresses, fee payers, etc.) and are never subject to eviction.
    if (account.owner === SYSTEM_PROGRAM_ID) {
      continue;
    }

    checkedCount++;

    if (account.lamports < account.requiredMinimum) {
      violations.push({
        address: account.address,
        lamports: account.lamports,
        requiredMinimum: account.requiredMinimum,
        deficit: account.requiredMinimum - account.lamports,
      });
    }
  }

  const has_non_rent_exempt_accounts = violations.length > 0;

  const details = has_non_rent_exempt_accounts
    ? violations
        .map(
          (v) =>
            `${v.address.slice(0, 8)}…: balance ${v.lamports} lamports, ` +
            `required ${v.requiredMinimum} lamports (deficit: ${v.deficit} lamports)`,
        )
        .join(" | ")
    : checkedCount > 0
      ? `All ${checkedCount} checked account(s) are rent-exempt.`
      : "No non-system accounts checked for rent exemption.";

  return {
    has_non_rent_exempt_accounts,
    violations,
    checkedCount,
    details,
  };
}
