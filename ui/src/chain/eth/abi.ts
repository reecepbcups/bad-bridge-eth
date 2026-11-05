import { parseAbi } from 'viem'

// The slices of eth/src/BadBridge.sol (and the OZ ERC721 errors it inherits) the app calls.
// abi.test.ts pins every selector to `forge inspect BadBridge methodIdentifiers` / `errors`.

/** BadBridge: reads, claim, submitBatch, and the custom errors those can revert with. */
export const bridgeAbi = parseAbi([
  'struct ConsensusState { uint128 timestamp; bytes32 root; bytes32 nextValidatorsHash; }',
  'struct SP1Proof { bytes32 vKey; bytes publicValues; bytes proof; }',
  'function lightClient() view returns (address)',
  'function proven(uint32 tokenId) view returns (address)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function ESCROW() view returns (bytes32)',
  'function ROUTER() view returns (address)',
  'function clientId() view returns (string)',
  'function claim(uint32 tokenId)',
  'function claimMany(uint32[] tokenIds)',
  'function submitBatch(uint64 proofHeight, ConsensusState cs, SP1Proof sp1Proof)',
  'error NotProven(uint32 tokenId)',
  'error ClientFrozen()',
  'error BadConsensusState()',
  'error BadVKey()',
  'error RootMismatch()',
  'error BadPath(uint256 index)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC721InvalidSender(address sender)',
  'error ERC721InvalidReceiver(address receiver)',
])

/** ISP1ICS07Tendermint: clientState() plus the reads submitBatch needs to rebuild and anchor a proof. */
export const lightClientAbi = parseAbi([
  'struct TrustThreshold { uint8 numerator; uint8 denominator; }',
  'struct Height { uint64 revisionNumber; uint64 revisionHeight; }',
  'function clientState() view returns (string chainId, TrustThreshold trustLevel, Height latestHeight, uint32 trustingPeriod, uint32 unbondingPeriod, bool isFrozen, uint8 zkAlgorithm)',
  'function getConsensusStateHash(uint64 revisionHeight) view returns (bytes32)',
  'function MEMBERSHIP_PROGRAM_VKEY() view returns (bytes32)',
])

/** IICS02Client.getCounterparty(), the slice of Eureka's ICS26Router the speed-up nudge needs. */
export const routerAbi = parseAbi([
  'function getClient(string clientId) view returns (address)',
  'struct CounterpartyInfo { string clientId; bytes[] merklePrefix; }',
  'function getCounterparty(string clientId) view returns (CounterpartyInfo)',
])

/** Multicall3.aggregate3 as a payable write (viem's multicall3Abi marks it view, which writeContract refuses). */
export const multicall3WriteAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
