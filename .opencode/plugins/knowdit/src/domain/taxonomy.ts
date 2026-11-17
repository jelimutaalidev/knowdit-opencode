export type TaxonomyEntry = {
  category: string;
  subcategory: string;
  description: string;
};

export const FINDING_TAXONOMY: readonly TaxonomyEntry[] = [
  {
    category: "Access Control",
    subcategory: "Arbitrary `from` in transferFrom() without msg.sender Check",
    description: "Detect when transferFrom uses an arbitrary from address without validating msg.sender.",
  },
  {
    category: "Access Control",
    subcategory: "Call to Arbitrary Addresses with Unchecked Calldata",
    description: "Calling arbitrary addresses with attacker-controlled calldata can trigger unexpected behavior.",
  },
  {
    category: "Access Control",
    subcategory: "Caller Not Checked",
    description: "Authorization assumes caller properties that can be bypassed, such as constructor-time extcodesize checks.",
  },
  {
    category: "Access Control",
    subcategory: "Contract Could be Destructed",
    description: "A privileged or unguarded path can destruct the contract or logic contract.",
  },
  {
    category: "Access Control",
    subcategory: "Dangerous Immediate Initialization of State Variables",
    description: "State is initialized through unsafe non-constant calls or mutable state dependencies.",
  },
  {
    category: "Access Control",
    subcategory: "Dangerous Usage of `tx.origin`",
    description: "Authorization depends on tx.origin and can be abused through call relays.",
  },
  {
    category: "Access Control",
    subcategory: "Default Function Visibility",
    description: "Missing explicit visibility exposes state-changing functions publicly.",
  },
  {
    category: "Access Control",
    subcategory: "Initializing Method without Permission Check",
    description: "Initialization can be triggered without an adequate permission check.",
  },
  {
    category: "Access Control",
    subcategory: "Method permit() Used for Arbitrary `from` in transferFrom()",
    description: "permit-based flows allow arbitrary transferFrom source selection without validating the true owner.",
  },
  {
    category: "Access Control",
    subcategory: "Missing `msg.sender` Check for transferFrom()",
    description: "transferFrom uses an attacker-controlled from address instead of binding to msg.sender or equivalent authorization.",
  },
  {
    category: "Access Control",
    subcategory: "Missing Input Validation",
    description: "Critical input values such as addresses, ids, chain selectors, or enum values are not validated.",
  },
  {
    category: "Access Control",
    subcategory: "Sending Ether to Arbitrary Destinations",
    description: "Ether can be sent to attacker-controlled destinations due to insufficient validation.",
  },
  {
    category: "Access Control",
    subcategory: "Unprotected Contract Destruction",
    description: "selfdestruct or equivalent destructive behavior is reachable without adequate protection.",
  },
  {
    category: "Access Control",
    subcategory: "Unprotected Ether Withdrawal",
    description: "Ether withdrawal paths are exposed without adequate access control or accounting.",
  },
  {
    category: "Access Control",
    subcategory: "Unsafe Delegatecall",
    description: "delegatecall is performed against unsafe or attacker-controlled targets.",
  },
  {
    category: "Access Control",
    subcategory: "Unused Return Value",
    description: "A critical external call return value is ignored, hiding failure or authorization problems.",
  },
  {
    category: "Access Control",
    subcategory: "Usage of public mint or burn",
    description: "Mint or burn functionality is exposed publicly or without sufficient authorization.",
  },
  {
    category: "Access Control",
    subcategory: "Write to Arbitrary Storage Location",
    description: "An attacker can influence writes to arbitrary storage slots or equivalent protected state.",
  },
  {
    category: "Arithmetic",
    subcategory: "Inappropriate Integer Division before Multiplication",
    description: "Integer division before multiplication truncates precision and causes incorrect accounting.",
  },
  {
    category: "Arithmetic",
    subcategory: "Integer Overflow",
    description: "Arithmetic can overflow and wrap or revert in a way that breaks intended invariants.",
  },
  {
    category: "Arithmetic",
    subcategory: "Integer Underflow",
    description: "Arithmetic can underflow and wrap or revert in a way that breaks intended invariants.",
  },
  {
    category: "Arithmetic",
    subcategory: "Unsafe Array Length Assignment",
    description: "User-controlled inputs can influence array length assignments or equivalent bounds changes.",
  },
  {
    category: "Block Manipulation",
    subcategory: "Dangerous Usage of `block.timestamp`",
    description: "Security-critical logic depends on block.timestamp or similarly manipulable block metadata.",
  },
  {
    category: "Block Manipulation",
    subcategory: "Transaction Order Dependency",
    description: "Correctness or fairness depends on transaction ordering and can be manipulated by frontrunning or reordering.",
  },
  {
    category: "Block Manipulation",
    subcategory: "Weak PRNG (Pseudorandom Number Generator)",
    description: "Randomness depends on predictable or miner-influenced blockchain values.",
  },
  {
    category: "Cryptographic",
    subcategory: "Lack of Proper Signature Verification",
    description: "Signed messages are accepted without sufficient signer, domain, nonce, or intent validation.",
  },
  {
    category: "Cryptographic",
    subcategory: "Signature Malleability",
    description: "Signatures can be altered into alternative valid encodings and replayed or mis-accounted.",
  },
  {
    category: "Denial of Services",
    subcategory: "`transfer()` and `send()` with Hardcoded Gas Amount",
    description: "Value transfer relies on fixed gas forwarding assumptions that can break protocol liveness.",
  },
  {
    category: "Denial of Services",
    subcategory: "Contract Could Lock Ether",
    description: "Funds can become permanently locked because the contract has no viable withdrawal or escape path.",
  },
  {
    category: "Denial of Services",
    subcategory: "DoS with Block Gas Limit",
    description: "Unbounded work or data growth can push execution beyond the block gas limit.",
  },
  {
    category: "Denial of Services",
    subcategory: "DoS With Failed Call",
    description: "A failed external call can block progress or cause protocol-wide denial of service.",
  },
  {
    category: "Denial of Services",
    subcategory: "Force Sending Ether with this.balance check in require() or assert()",
    description: "Force-sent ether can break logic that relies on exact balance checks.",
  },
  {
    category: "Denial of Services",
    subcategory: "Unsafe send() in the require() Condition",
    description: "send inside a require/assert style condition can be weaponized to revert protocol progress.",
  },
  {
    category: "Reentrancy",
    subcategory: "Reentrancy Vulnerability with Negative Events",
    description: "External control flow can reenter before state is safely updated, leading to invalid negative-state effects.",
  },
  {
    category: "Reentrancy",
    subcategory: "Reentrancy Vulnerability with Transfer",
    description: "An external transfer opens a reentrant path before invariant-preserving state updates complete.",
  },
  {
    category: "Reentrancy",
    subcategory: "Reentrancy Vulnerability with Same Effect",
    description: "Reentrancy repeats the same state transition or accounting effect multiple times.",
  },
  {
    category: "Reentrancy",
    subcategory: "Reentrancy Vulnerability with ETH Transfer",
    description: "ETH transfer creates a callback path that can reenter before state is finalized.",
  },
  {
    category: "Reentrancy",
    subcategory: "Reentrancy Vulnerability without ETH Transfer",
    description: "An external call without direct ETH transfer still enables reentrant state corruption.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Arbitrary Function Jump via Inline Assembly",
    description: "Inline assembly can redirect execution or corrupt function pointers or equivalent dispatch state.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Bytes Variables Risk",
    description: "Improper ABI-decoding or bytes handling causes ambiguous values, truncation, or collision-like behavior.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Dangerous Usage of `msg.value` inside a Loop",
    description: "msg.value is reused inside loops and causes repeated accounting or payout errors.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Error-prone Assembly Usage",
    description: "Low-level assembly is used in a way that can corrupt state or bypass invariants.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Memory Manipulation",
    description: "Unsafe memory access or mutation causes incorrect behavior, corruption, or exploitable state transitions.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Modifying storage array by value",
    description: "Storage arrays are handled with the wrong copy/reference semantics and cause unintended mutation.",
  },
  {
    category: "Storage & Memory",
    subcategory: "Payable Functions using `delegatecall` inside a Loop",
    description: "delegatecall in a payable loop can multiply accounting effects or corrupt balance tracking.",
  },
];
