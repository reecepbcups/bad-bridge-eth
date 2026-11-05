// BadBridge.sol at the entry point level. Each external function is one action with its checks in
// code order. A revert rolls everything back, so a failed call only touches the ghost vars.
// The Hub is modeled as raw KV state the Eureka client snapshots, attackers included.
module bridge {
  // false drops parse's escrow/namespace checks and the holder check on transfers
  const GUARDS: bool
  // CLIENT resolved once at deploy. false means asking the router on every call, like before
  const PINNED: bool

  pure val NONE = ""
  pure val ZERO = "0x0"
  pure val EVE = "eve"
  pure val USERS = Set("alice", "bob", EVE)
  // no owner. The deployer is just another caller
  pure val CALLERS = USERS.union(Set("deployer", "dao"))

  // Hub side. "long" is any value that isn't 20 bytes
  pure val ESCROW = "escrow"
  pure val EVIL = "evil"
  pure val VALUES = Set("alice", "bob", EVE, "long")
  pure val IDS = Set(1, 2)
  type KV = { store: str, contract: str, tag: str, id: int, value: str }

  // BadBridge.parse: ["wasm", 0x03 || ESCROW || "b" || u32] with a 20 byte value
  pure def parses(kv: KV): bool =
    kv.store == "wasm" and kv.tag == "b" and kv.value != "long" and (not(GUARDS) or kv.contract == ESCROW)

  type Res = { ok: bool, err: str }
  pure val OK: Res = { ok: true, err: "" }
  pure def err(e: str): Res = { ok: false, err: e }

  // Hub
  var hub: Set[KV]
  // what the escrow recorded for each id, written once (escrow.qnt proves that with the admin renounced)
  var escrowRecord: int -> str
  // Eureka client
  var roots: List[Set[KV]]
  var frozen: bool
  // Eureka's router admin pointed "cosmoshub-0" at a client that verifies anything
  var routerSwapped: bool

  // BadBridge storage
  var proven: int -> str
  var nftOwner: int -> str
  // what delegate() stored. NONE means unset, which reads as self
  var delegatee: str -> str
  var votes: str -> int

  // ghosts
  var last: { caller: str, kind: str, res: Res, prevHolder: str }
  var mintedTo: int -> str
  var mints: int -> int
  var provenChanges: Set[(str, str)]
  var kidsMoved: bool

  def delegates(a: str): str = if (delegatee.get(a) == NONE) a else delegatee.get(a)
  def balance(a: str): int = IDS.filter(t => nftOwner.get(t) == a).size()
  def supply: int = IDS.filter(t => nftOwner.get(t) != NONE).size()

  action init = all {
    hub' = Set(),
    escrowRecord' = IDS.mapBy(_ => NONE),
    roots' = [],
    frozen' = false,
    routerSwapped' = false,
    proven' = IDS.mapBy(_ => NONE),
    nftOwner' = IDS.mapBy(_ => NONE),
    delegatee' = CALLERS.mapBy(_ => NONE),
    votes' = CALLERS.mapBy(_ => 0),
    last' = { caller: NONE, kind: "init", res: OK, prevHolder: NONE },
    mintedTo' = IDS.mapBy(_ => NONE),
    mints' = IDS.mapBy(_ => 0),
    provenChanges' = Set(),
    kidsMoved' = false,
  }

  action hubSame = all { hub' = hub, escrowRecord' = escrowRecord, roots' = roots, frozen' = frozen, routerSwapped' = routerSwapped }
  action ethSame = all {
    proven' = proven, nftOwner' = nftOwner, delegatee' = delegatee, votes' = votes, mintedTo' = mintedTo, mints' = mints,
  }
  action noKids = all { provenChanges' = Set(), kidsMoved' = false }
  def lastOf(caller: str, kind: str, res: Res): { caller: str, kind: str, res: Res, prevHolder: str } =
    { caller: caller, kind: kind, res: res, prevHolder: NONE }

  // ---- Hub ----

  // escrow ReceiveNft writes the "b" record and the "s" refund address (not 20 bytes)
  action hubEscrow(t: int, r: str): bool = all {
    escrowRecord.get(t) == NONE,
    r != "long",
    escrowRecord' = escrowRecord.set(t, r),
    hub' = hub.union(Set(
      { store: "wasm", contract: ESCROW, tag: "b", id: t, value: r },
      { store: "wasm", contract: ESCROW, tag: "s", id: t, value: "long" },
    )),
    roots' = roots, frozen' = frozen, routerSwapped' = routerSwapped, ethSame, noKids,
    last' = lastOf(NONE, "hub", OK),
  }

  // any other contract or module can write whatever it likes under its own keys
  action hubAttacker(store: str, tag: str, t: int, v: str): bool = {
    val k = { store: store, contract: EVIL, tag: tag, id: t, value: v }
    all {
      hub' = hub.filter(x => not(x.store == store and x.contract == EVIL and x.tag == tag and x.id == t)).union(Set(k)),
      escrowRecord' = escrowRecord, roots' = roots, frozen' = frozen, routerSwapped' = routerSwapped, ethSame, noKids,
      last' = lastOf(EVE, "hub", OK),
    }
  }

  // Eureka relayer traffic stores a new consensus state
  action clientUpdate: bool = all {
    roots.length() < 3,
    not(frozen),
    roots' = roots.append(hub),
    hub' = hub, escrowRecord' = escrowRecord, frozen' = frozen, routerSwapped' = routerSwapped, ethSame, noKids,
    last' = lastOf(NONE, "client", OK),
  }

  action freeze: bool = all {
    frozen' = true,
    hub' = hub, escrowRecord' = escrowRecord, roots' = roots, routerSwapped' = routerSwapped, ethSame, noKids,
    last' = lastOf(NONE, "client", OK),
  }

  // router admin runs migrateClient. A pinned bridge never looks at the router again
  action routerMigrate: bool = all {
    routerSwapped' = true,
    hub' = hub, escrowRecord' = escrowRecord, roots' = roots, frozen' = frozen, ethSame, noKids,
    last' = lastOf(NONE, "router", OK),
  }

  // ---- BadBridge ----

  // csOk: the caller passed the consensus state the client stores. vkOk: the membership vkey.
  // A proof only verifies if every kv sits in that root, the SP1 + ICS07 soundness assumption.
  def submitRes(i: int, kvs: Set[KV], csOk: bool, vkOk: bool): Res =
    // the swapped client says yes to every consensus state, vkey and proof
    if (routerSwapped and not(PINNED)) (if (kvs.exists(kv => not(parses(kv)))) err("BadPath") else OK)
    else if (frozen) err("ClientFrozen")
    else if (not(csOk) or i >= roots.length()) err("BadConsensusState")
    else if (not(vkOk)) err("BadVKey")
    else if (not(kvs.subseteq(roots[i]))) err("BadProof")
    else if (kvs.exists(kv => not(parses(kv)))) err("BadPath")
    else OK

  action submitBatch(caller: str, i: int, kvs: Set[KV], csOk: bool, vkOk: bool): bool = {
    val res = submitRes(i, kvs, csOk, vkOk)
    // first record wins, a root holds one value per id so set order can't matter
    val nxt = IDS.mapBy(t => {
      val hits = kvs.filter(kv => kv.id == t)
      if (proven.get(t) == NONE and hits.size() > 0) hits.fold(NONE, (acc, kv) => kv.value) else proven.get(t)
    })
    all {
      last' = lastOf(caller, "submit", res),
      hubSame,
      if (res.ok) all {
        proven' = nxt,
        provenChanges' = IDS.filter(t => nxt.get(t) != proven.get(t)).map(t => (proven.get(t), nxt.get(t))),
        kidsMoved' = nxt != proven,
        nftOwner' = nftOwner, delegatee' = delegatee, votes' = votes, mintedTo' = mintedTo, mints' = mints,
      } else all { ethSame, noKids },
    }
  }

  // _mint, with ERC721Votes moving one vote to the recipient's delegate
  action mintTo(t: int, rcpt: str): bool = all {
    nftOwner' = nftOwner.set(t, rcpt),
    votes' = votes.set(delegates(rcpt), votes.get(delegates(rcpt)) + 1),
    mintedTo' = mintedTo.set(t, rcpt),
    mints' = mints.set(t, mints.get(t) + 1),
  }

  def claimRes(t: int): Res =
    if (proven.get(t) == NONE) err("NotProven")
    else if (nftOwner.get(t) != NONE) err("ERC721InvalidSender")
    else OK

  action claim(caller: str, t: int): bool = {
    val res = claimRes(t)
    all {
      last' = lastOf(caller, "claim", res),
      hubSame,
      if (res.ok) all {
        mintTo(t, proven.get(t)),
        proven' = proven, delegatee' = delegatee,
        provenChanges' = Set(), kidsMoved' = true,
      } else all { ethSame, noKids },
    }
  }

  // claimMany over up to two ids. Unproven anywhere reverts all, already minted is skipped.
  action claimMany(caller: str, ids: List[int]): bool = {
    val res = if (ids.indices().exists(i => proven.get(ids[i]) == NONE)) err("NotProven") else OK
    val fresh = ids.foldl(Set(), (acc, t) => if (nftOwner.get(t) == NONE) acc.union(Set(t)) else acc)
    all {
      last' = lastOf(caller, "claimMany", res),
      hubSame,
      if (res.ok) all {
        nftOwner' = IDS.mapBy(t => if (fresh.contains(t)) proven.get(t) else nftOwner.get(t)),
        votes' = CALLERS.mapBy(a => votes.get(a) + fresh.filter(t => delegates(proven.get(t)) == a).size()),
        mintedTo' = IDS.mapBy(t => if (fresh.contains(t)) proven.get(t) else mintedTo.get(t)),
        mints' = IDS.mapBy(t => if (fresh.contains(t)) mints.get(t) + 1 else mints.get(t)),
        proven' = proven, delegatee' = delegatee,
        provenChanges' = Set(), kidsMoved' = fresh.size() > 0,
      } else all { ethSame, noKids },
    }
  }

  // transferFrom by the holder (approvals are stock OZ, left out)
  action transferFrom(caller: str, t: int, dest: str): bool = {
    val from = nftOwner.get(t)
    val res =
      if (from == NONE) err("ERC721NonexistentToken")
      else if (GUARDS and caller != from) err("ERC721InsufficientApproval")
      else if (dest == ZERO) err("ERC721InvalidReceiver")
      else OK
    all {
      last' = { ...lastOf(caller, "transfer", res), prevHolder: from },
      hubSame,
      if (res.ok) all {
        nftOwner' = nftOwner.set(t, dest),
        votes' = if (delegates(from) == delegates(dest)) votes
          else votes.set(delegates(from), votes.get(delegates(from)) - 1).set(delegates(dest), votes.get(delegates(dest)) + 1),
        proven' = proven, delegatee' = delegatee,
        mintedTo' = mintedTo, mints' = mints,
        provenChanges' = Set(), kidsMoved' = true,
      } else all { ethSame, noKids },
    }
  }

  // delegate(0) maps to self, same as the override
  action delegate(caller: str, d: str): bool = {
    val nxt = if (d == ZERO) caller else d
    val old = delegates(caller)
    val bal = balance(caller)
    all {
      CALLERS.contains(nxt),
      last' = lastOf(caller, "delegate", OK),
      hubSame, noKids,
      delegatee' = delegatee.set(caller, nxt),
      votes' = if (old == nxt) votes else votes.set(old, votes.get(old) - bal).set(nxt, votes.get(nxt) + bal),
      proven' = proven, nftOwner' = nftOwner, mintedTo' = mintedTo, mints' = mints,
    }
  }

  pure val UNIVERSE: Set[KV] = tuples(Set("wasm", "ibc"), Set(ESCROW, EVIL), Set("b", "s"), IDS, VALUES)
    .map(x => { store: x._1, contract: x._2, tag: x._3, id: x._4, value: x._5 })

  action step = {
    nondet caller = CALLERS.oneOf()
    nondet t = IDS.oneOf()
    nondet u = IDS.oneOf()
    nondet dest = CALLERS.union(Set(ZERO)).oneOf()
    nondet v = VALUES.oneOf()
    nondet store = Set("wasm", "ibc").oneOf()
    nondet tag = Set("b", "s").oneOf()
    nondet i = 0.to(2).oneOf()
    nondet k1 = UNIVERSE.oneOf()
    nondet k2 = UNIVERSE.oneOf()
    // proofs are mostly drawn from a real root, so batches actually land
    nondet fromRoot = Set(true, false).oneOf()
    nondet r1 = (if (i < roots.length() and roots[i].size() > 0) roots[i] else UNIVERSE).oneOf()
    nondet r2 = (if (i < roots.length() and roots[i].size() > 0) roots[i] else UNIVERSE).oneOf()
    nondet csOk = Set(true, true, false).oneOf()
    nondet vkOk = Set(true, false).oneOf()
    nondet n = 1.to(2).oneOf()
    any {
      hubEscrow(t, v),
      hubAttacker(store, tag, t, v),
      clientUpdate,
      freeze,
      routerMigrate,
      submitBatch(caller, i, if (fromRoot) Set(r1, r2) else Set(k1, k2), csOk, vkOk),
      claim(caller, t),
      claimMany(caller, if (n == 1) [t] else [t, u]),
      transferFrom(caller, t, dest),
      delegate(caller, dest),
    }
  }

  // Ethereum only ever records what the escrow recorded, nothing another contract or store wrote
  val provenSound = IDS.forall(t => proven.get(t) == NONE or proven.get(t) == escrowRecord.get(t))

  // a proven recipient is set once and never changes
  val provenWriteOnce = provenChanges.forall(c => c._1 == NONE)

  // each kid mints at most once, to its proven recipient, and only once proven
  val mintsMatchProven = IDS.forall(t =>
    mints.get(t) <= 1 and (mintedTo.get(t) == NONE or mintedTo.get(t) == proven.get(t))
    and (nftOwner.get(t) == NONE or proven.get(t) != NONE))

  // nothing lands while the client is frozen
  val frozenBlocksSubmit = (last.kind == "submit" and last.res.ok) implies not(frozen)

  // a kid only moves when its holder moves it
  val onlyHolderTransfers = (last.kind == "transfer" and last.res.ok) implies last.caller == last.prevHolder

  // kids and records only change through submit, claim and transfer, never a delegate or Hub step
  val onlyBridgeCallsTouchKids = kidsMoved implies Set("submit", "claim", "claimMany", "transfer").contains(last.kind)

  // every vote is a kid held by someone who delegates there, and they add up to supply
  val votesMatchDelegations = CALLERS.forall(a => votes.get(a) == CALLERS.filter(h => delegates(h) == a).fold(0, (s, h) => s + balance(h)))
  val votesSumToSupply = CALLERS.fold(0, (s, a) => s + votes.get(a)) == supply

  val safety = provenSound and provenWriteOnce and mintsMatchProven and frozenBlocksSubmit
    and onlyHolderTransfers and onlyBridgeCallsTouchKids and votesMatchDelegations and votesSumToSupply

  // Witnesses. Should be violated, so the happy paths are reachable.
  val witnessNothingMinted = IDS.forall(t => nftOwner.get(t) == NONE)
  val witnessNoTransfer = not(last.kind == "transfer" and last.res.ok)
  val witnessNoDelegation = CALLERS.forall(a => delegates(a) == a)
}

// what's in BadBridge.sol
module bridgeProd {
  import bridge(GUARDS = true, PINNED = true).*
}

// checks removed. Should break provenSound and onlyHolderTransfers.
module bridgeNoGuards {
  import bridge(GUARDS = false, PINNED = true).*
}

// client looked up through the router on every call. Should break provenSound once the router admin migrates it.
module bridgeUnpinned {
  import bridge(GUARDS = true, PINNED = false).*
}
