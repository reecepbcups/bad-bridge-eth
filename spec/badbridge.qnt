// Bad Bridge, Hub escrow to Ethereum mint. Proofs are modeled as sound: a batch can only
// carry records that sat in a Hub root the light client accepted. That's the SP1 + ICS07 assumption.
module badbridge {
  // cw721 admin can migrate the collection and move anything, escrowed kids included
  const ADMIN_MIGRATES: bool
  // minter or migration supervisor can mint new token id strings
  const SUPERVISOR_MINTS: bool
  // escrow only accepts token ids in canonical u32 form (fix for "+1" / "01")
  const CANONICAL_CHECK: bool
  // escrow admin not renounced yet, so EmergencyUnlock is live
  const UNLOCK_ADMIN: bool
  // escrow still has a wasm admin, so its code can be migrated to anything
  const ESCROW_MIGRATES: bool
  // senders check the pinned client before every send. The escrow doesn't, so this only holds through the UI
  const SEND_GUARD: bool

  pure val NONE = ""
  pure val ESCROW = "escrow"
  pure val ZERO = "zero"
  pure val ATTACKER = "eve"
  pure val HOLDERS = Set("alice", "bob", ATTACKER)
  pure val RECIPIENTS = HOLDERS.union(Set(ZERO))

  pure val IDS = Set(1, 2)
  // "+1" parses to 1 in Rust, it's the alias a supervisor could mint
  pure val STRS = Set("1", "2", "+1")
  pure def parseId(s: str): int = if (s == "2") 2 else 1
  pure def canon(t: int): str = if (t == 2) "2" else "1"
  pure def isCanonical(s: str): bool = s == canon(parseId(s))

  // Hub
  var hubOwner: str -> str
  var record: int -> str
  // escrow refund address per id, what EmergencyUnlock sends back to
  var senderOf: int -> str
  // Hub roots the Eureka client accepted, each one a snapshot of the escrow records
  var roots: List[int -> str]
  // Ethereum
  var proven: int -> str
  var ethOwner: int -> str
  // ghost, who claim first minted each kid to
  var mintedTo: int -> str
  // the pinned light client can still take new Hub roots. Frozen, expired and retired all end it for good
  var clientLive: bool
  // ghost, ids sent into the escrow after the client died
  var deadSends: Set[int]

  action init = all {
    hubOwner' = Map("1" -> "alice", "2" -> "bob", "+1" -> NONE),
    record' = IDS.mapBy(_ => NONE),
    senderOf' = IDS.mapBy(_ => NONE),
    roots' = [],
    proven' = IDS.mapBy(_ => NONE),
    ethOwner' = IDS.mapBy(_ => NONE),
    mintedTo' = IDS.mapBy(_ => NONE),
    clientLive' = true,
    deadSends' = Set(),
  }

  action hubTransfer(s: str, dest: str): bool = all {
    hubOwner.get(s) != NONE,
    hubOwner.get(s) != ESCROW,
    hubOwner' = hubOwner.set(s, dest),
    record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // cw721 send_nft into the escrow, ReceiveNft hook checks
  action sendToEscrow(s: str, recipient: str): bool = all {
    hubOwner.get(s) != NONE,
    hubOwner.get(s) != ESCROW,
    not(CANONICAL_CHECK) or isCanonical(s),
    recipient != ZERO,
    record.get(parseId(s)) == NONE,
    not(SEND_GUARD) or clientLive,
    hubOwner' = hubOwner.set(s, ESCROW),
    record' = record.set(parseId(s), recipient),
    senderOf' = senderOf.set(parseId(s), hubOwner.get(s)),
    roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive,
    deadSends' = if (clientLive) deadSends else deadSends.union(Set(parseId(s))),
  }

  // Eureka relayer traffic advances the client, we never call updateClient ourselves
  action clientUpdate: bool = all {
    roots.length() < 4,
    clientLive,
    roots' = roots.append(record),
    hubOwner' = hubOwner, record' = record, senderOf' = senderOf, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // anyone can submit, any accepted root, any subset of what that root holds
  action submitBatch(i: int, ids: Set[int]): bool = all {
    i < roots.length(),
    ids != Set(),
    ids.forall(t => roots[i].get(t) != NONE),
    proven' = IDS.mapBy(t => if (ids.contains(t) and proven.get(t) == NONE) roots[i].get(t) else proven.get(t)),
    hubOwner' = hubOwner, record' = record, senderOf' = senderOf, roots' = roots, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  action claim(t: int): bool = all {
    proven.get(t) != NONE,
    ethOwner.get(t) == NONE,
    ethOwner' = ethOwner.set(t, proven.get(t)),
    mintedTo' = mintedTo.set(t, proven.get(t)),
    hubOwner' = hubOwner, record' = record, senderOf' = senderOf, roots' = roots, proven' = proven,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  action ethTransfer(t: int, dest: str): bool = all {
    ethOwner.get(t) != NONE,
    dest != ZERO,
    ethOwner' = ethOwner.set(t, dest),
    hubOwner' = hubOwner, record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  action supervisorMintAlias: bool = all {
    SUPERVISOR_MINTS,
    hubOwner.get("+1") == NONE,
    hubOwner' = hubOwner.set("+1", ATTACKER),
    record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // migrated cw721 code calls ReceiveNft without moving the kid
  action adminForgeRecord(t: int, recipient: str): bool = all {
    ADMIN_MIGRATES,
    record.get(t) == NONE,
    recipient != ZERO,
    record' = record.set(t, recipient),
    senderOf' = senderOf.set(t, ATTACKER),
    hubOwner' = hubOwner, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // migrated cw721 code moves an escrowed kid back out
  action adminPull(s: str): bool = all {
    ADMIN_MIGRATES,
    hubOwner.get(s) == ESCROW,
    hubOwner' = hubOwner.set(s, ATTACKER),
    record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // EmergencyUnlock: clears the record and hands the kid back to whoever sent it.
  // The admin follows the lib.rs doc and only unlocks kids with no Proven event on Ethereum yet.
  action adminUnlock(t: int): bool = all {
    UNLOCK_ADMIN,
    record.get(t) != NONE,
    proven.get(t) == NONE,
    hubOwner' = hubOwner.set(canon(t), senderOf.get(t)),
    record' = record.set(t, NONE),
    senderOf' = senderOf.set(t, NONE),
    roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  // Client freezes on misbehaviour, expires past its trusting period, or the router retires it and
  // relayers move on. The bridge pinned it at deploy, so no new root ever lands after this.
  action clientDies: bool = all {
    clientLive,
    clientLive' = false,
    hubOwner' = hubOwner, record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    deadSends' = deadSends,
  }

  // escrow wasm admin migrates the code and walks an escrowed kid out, record left in place
  action escrowRelease(t: int): bool = all {
    ESCROW_MIGRATES,
    hubOwner.get(canon(t)) == ESCROW,
    hubOwner' = hubOwner.set(canon(t), ATTACKER),
    record' = record, senderOf' = senderOf, roots' = roots, proven' = proven, ethOwner' = ethOwner, mintedTo' = mintedTo,
    clientLive' = clientLive, deadSends' = deadSends,
  }

  action step = {
    nondet s = STRS.oneOf()
    nondet t = IDS.oneOf()
    nondet who = HOLDERS.oneOf()
    nondet recipient = RECIPIENTS.oneOf()
    nondet ids = IDS.powerset().oneOf()
    nondet i = 0.to(3).oneOf()
    any {
      hubTransfer(s, who),
      sendToEscrow(s, recipient),
      clientUpdate,
      submitBatch(i, ids),
      claim(t),
      ethTransfer(t, who),
      supervisorMintAlias,
      adminPull(s),
      adminForgeRecord(t, recipient),
      adminUnlock(t),
      clientDies,
      escrowRelease(t),
    }
  }

  // Ethereum only ever records what the Hub escrow recorded
  val provenMatchesRecord = IDS.forall(t => proven.get(t) == NONE or proven.get(t) == record.get(t))

  // a kid live on Ethereum is locked in the escrow on the Hub, so it can't exist twice
  val noDoubleSpend = IDS.forall(t => ethOwner.get(t) == NONE or hubOwner.get(canon(t)) == ESCROW)

  // records never change once a root commits to them, so every root agrees with today
  val rootsAgree = roots.indices().forall(i => IDS.forall(t => roots[i].get(t) == NONE or roots[i].get(t) == record.get(t)))

  // an escrowed kid can always be claimed by someone, a zero recipient would strand it
  val noStrandedKid = IDS.forall(t => record.get(t) != ZERO)

  // the kid lands with whoever the Hub holder named, nobody else
  val mintedToRecord = IDS.forall(t => mintedTo.get(t) == NONE or mintedTo.get(t) == record.get(t))

  // nobody sends a kid into a client that can never prove it. Kids already in flight when it dies
  // are still stuck, see the noSendGuard module
  val noDeadSends = deadSends == Set()

  val safety = provenMatchesRecord and noDoubleSpend and rootsAgree and noStrandedKid and mintedToRecord and noDeadSends

  // Witnesses. These should be violated, proving the happy path is reachable and safety isn't vacuous.
  val witnessNothingMinted = IDS.forall(t => ethOwner.get(t) == NONE)
  val witnessNotAllMinted = IDS.exists(t => ethOwner.get(t) == NONE)
}

// What we ship: canonical ids, no cw721 admin, escrow admin renounced. Should hold.
module prod {
  import badbridge(ADMIN_MIGRATES = false, SUPERVISOR_MINTS = true, CANONICAL_CHECK = true, UNLOCK_ADMIN = false, ESCROW_MIGRATES = false, SEND_GUARD = true).*
}

// Bad Kids on the Hub today: a single key is cw721 admin. Should break noDoubleSpend.
module today {
  import badbridge(ADMIN_MIGRATES = true, SUPERVISOR_MINTS = true, CANONICAL_CHECK = true, UNLOCK_ADMIN = false, ESCROW_MIGRATES = false, SEND_GUARD = true).*
}

// Pre fix escrow that took "+1" as 1. Should break noDoubleSpend.
module noCanonicalCheck {
  import badbridge(ADMIN_MIGRATES = false, SUPERVISOR_MINTS = true, CANONICAL_CHECK = false, UNLOCK_ADMIN = false, ESCROW_MIGRATES = false, SEND_GUARD = true).*
}

// Escrow admin still live, and only unlocks unproven kids like the doc says. Still breaks noDoubleSpend,
// because a root taken before the unlock proves the old record forever.
module adminLive {
  import badbridge(ADMIN_MIGRATES = false, SUPERVISOR_MINTS = true, CANONICAL_CHECK = true, UNLOCK_ADMIN = true, ESCROW_MIGRATES = false, SEND_GUARD = true).*

  // Bob bridges kid 2, a root lands, admin sees no Proven event and refunds him.
  // The old root still proves the record, so anyone mints kid 2 on Ethereum while Bob holds it on the Hub.
  run doubleSpendAfterHonestUnlock =
    init
      .then(sendToEscrow("2", "bob"))
      .then(clientUpdate)
      .then(adminUnlock(2))
      .then(submitBatch(0, Set(2)))
      .then(claim(2))
      .then(all { assert(not(noDoubleSpend)), assert(hubOwner.get("2") == "bob" and ethOwner.get(2) == "bob"), step })

  // Same start, but Bob sells the refunded kid to Alice, who bridges it to herself.
  // Bob replays the old root first. Alice's kid is locked in the escrow and Bob gets it on Ethereum.
  run theftAfterHonestUnlock =
    init
      .then(sendToEscrow("2", "bob"))
      .then(clientUpdate)
      .then(adminUnlock(2))
      .then(hubTransfer("2", "alice"))
      .then(sendToEscrow("2", "alice"))
      .then(submitBatch(0, Set(2)))
      .then(claim(2))
      .then(all {
        assert(not(mintedToRecord)),
        assert(record.get(2) == "alice" and hubOwner.get("2") == ESCROW and ethOwner.get(2) == "bob"),
        step,
      })
}

// Escrow wasm admin not cleared. Should break noDoubleSpend.
module escrowAdminLive {
  import badbridge(ADMIN_MIGRATES = false, SUPERVISOR_MINTS = true, CANONICAL_CHECK = true, UNLOCK_ADMIN = false, ESCROW_MIGRATES = true, SEND_GUARD = true).*
}

// Sends without checking the pinned client. Should break noDeadSends.
module noSendGuard {
  import badbridge(ADMIN_MIGRATES = false, SUPERVISOR_MINTS = true, CANONICAL_CHECK = true, UNLOCK_ADMIN = false, ESCROW_MIGRATES = false, SEND_GUARD = false).*

  // Alice sends kid 1 after the client died. No root can ever hold it, so it never reaches Ethereum.
  run sendIntoDeadClient =
    init
      .then(clientDies)
      .then(sendToEscrow("1", "alice"))
      .then(all { assert(not(noDeadSends)), assert(not(clientLive)), step })

  // The guard can't help a kid sent while the client was live. It dies before a root lands and the kid
  // sits in the escrow for good, even in prod.
  run strandedInFlight =
    init
      .then(sendToEscrow("1", "alice"))
      .then(clientDies)
      .then(all {
        assert(noDeadSends),
        assert(record.get(1) == "alice" and roots.length() == 0 and not(clientLive)),
        step,
      })
}
