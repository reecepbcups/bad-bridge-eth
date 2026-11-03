// Bad Bridge escrow (escrow/src/lib.rs) at the entry point level. Each execute arm is one action,
// with its checks in the same order as the code, so the access control here is the access control there.
// Errors revert the whole tx, so a failed call only touches the ghost vars.
module escrow {
  // false drops the cw721 and admin caller checks, so we can see the invariants actually bite
  const GUARDS: bool

  pure val NONE = ""
  pure val ESCROW = "escrow"
  pure val CW721 = "cw721"
  pure val ADMIN = "admin"
  pure val EVE = "eve"
  pure val HOLDERS = Set("alice", "bob", EVE)
  pure val CALLERS = Set(CW721, ADMIN).union(HOLDERS)
  // eth recipients. "short" stands in for any msg that isn't 20 bytes
  pure val ZERO = "0x00"
  pure val SHORT = "short"
  pure val RECIPIENTS = Set("0xaa", "0xbb", ZERO, SHORT)

  // cw721 token id strings. "+1" and "01" parse to 1 in Rust, "x" doesn't parse at all
  pure val STRS = Set("1", "2", "+1", "01", "x")
  // 3 is an id nobody holds, so unlock can name something that was never escrowed
  pure val IDS = Set(1, 2, 3)
  // -1 is "not a canonical u32", what the parse + to_string round trip rejects
  pure def canonicalId(s: str): int = if (s == "1") 1 else if (s == "2") 2 else -1
  pure def idStr(t: int): str = if (t == 1) "1" else if (t == 2) "2" else "3"

  type Res = { ok: bool, err: str }
  pure val OK: Res = { ok: true, err: "" }
  pure def err(e: str): Res = { ok: false, err: e }

  // contract storage
  var record: int -> str
  var sender: int -> str
  var admin: str
  // the cw721's view, who holds each token string
  var holder: str -> str

  // ghosts
  var last: { caller: str, kind: str, res: Res }
  var everRenounced: bool
  // (old, new) record value for every id the last call touched
  var recordChanges: Set[(str, str)]

  action init = all {
    record' = IDS.mapBy(_ => NONE),
    sender' = IDS.mapBy(_ => NONE),
    admin' = ADMIN,
    // worst case cw721, the supervisor minted every alias to eve
    holder' = Map("1" -> "alice", "2" -> "bob", "+1" -> EVE, "01" -> EVE, "x" -> EVE, "3" -> NONE),
    last' = { caller: NONE, kind: "init", res: OK },
    everRenounced' = false,
    recordChanges' = Set(),
  }

  // ExecuteMsg::ReceiveNft
  def receiveRes(caller: str, s: str, recipient: str): Res =
    if (GUARDS and caller != CW721) err("WrongCollection")
    else if (canonicalId(s) < 0) err("BadTokenId")
    else if (recipient == SHORT) err("BadRecipient")
    else if (recipient == ZERO) err("ZeroRecipient")
    else if (record.get(canonicalId(s)) != NONE) err("AlreadyBridged")
    else OK

  // ExecuteMsg::EmergencyUnlock, all or nothing over the list
  def unlockRes(caller: str, ids: List[int]): Res =
    if (GUARDS and (admin == NONE or caller != admin)) err("Unauthorized")
    // a repeat hits NotEscrowed because the first copy already cleared it
    else if (ids.indices().exists(i => record.get(ids[i]) == NONE or ids.indices().exists(j => j < i and ids[j] == ids[i])))
      err("NotEscrowed")
    else OK

  // ExecuteMsg::RenounceAdmin
  def renounceRes(caller: str): Res =
    if (GUARDS and (admin == NONE or caller != admin)) err("Unauthorized") else OK

  action unchangedStorage = all {
    record' = record, sender' = sender, admin' = admin, holder' = holder,
    everRenounced' = everRenounced, recordChanges' = Set(),
  }

  // cw721 send_nft: moves the token to the escrow and calls ReceiveNft as the cw721.
  // If the hook fails the cw721 tx reverts too, so the token stays put.
  action sendNft(from: str, s: str, recipient: str): bool = {
    val res = receiveRes(CW721, s, recipient)
    val t = canonicalId(s)
    all {
      holder.get(s) == from,
      last' = { caller: CW721, kind: "receive", res: res },
      if (res.ok) all {
        record' = record.set(t, recipient),
        sender' = sender.set(t, from),
        holder' = holder.set(s, ESCROW),
        admin' = admin, everRenounced' = everRenounced,
        recordChanges' = Set((NONE, recipient)),
      } else unchangedStorage,
    }
  }

  // anyone else calling ReceiveNft directly, claiming they sent a kid they didn't
  action spoofReceive(caller: str, from: str, s: str, recipient: str): bool = {
    val res = receiveRes(caller, s, recipient)
    val t = canonicalId(s)
    all {
      caller != CW721,
      last' = { caller: caller, kind: "receive", res: res },
      if (res.ok) all {
        record' = record.set(t, recipient),
        sender' = sender.set(t, from),
        holder' = holder, admin' = admin, everRenounced' = everRenounced,
        recordChanges' = Set((record.get(t), recipient)),
      } else unchangedStorage,
    }
  }

  action emergencyUnlock(caller: str, ids: List[int]): bool = {
    val res = unlockRes(caller, ids)
    val touched = ids.foldl(Set(), (acc, t) => acc.union(Set(t)))
    all {
      last' = { caller: caller, kind: "unlock", res: res },
      if (res.ok) all {
        record' = IDS.mapBy(t => if (touched.contains(t)) NONE else record.get(t)),
        sender' = IDS.mapBy(t => if (touched.contains(t)) NONE else sender.get(t)),
        // TransferNft back to whoever sent it, by its canonical string
        holder' = holder.keys().mapBy(s => if (canonicalId(s) >= 0 and touched.contains(canonicalId(s))) sender.get(canonicalId(s)) else holder.get(s)),
        admin' = admin, everRenounced' = everRenounced,
        recordChanges' = touched.map(t => (record.get(t), NONE)),
      } else unchangedStorage,
    }
  }

  action renounceAdmin(caller: str): bool = {
    val res = renounceRes(caller)
    all {
      last' = { caller: caller, kind: "renounce", res: res },
      if (res.ok) all {
        admin' = NONE, everRenounced' = true,
        record' = record, sender' = sender, holder' = holder, recordChanges' = Set(),
      } else unchangedStorage,
    }
  }

  // plain cw721 transfer, no hook. Sending straight to the escrow strands the kid, that's on the user.
  action transferNft(from: str, s: str, dest: str): bool = all {
    holder.get(s) == from,
    from != ESCROW,
    holder' = holder.set(s, dest),
    record' = record, sender' = sender, admin' = admin, everRenounced' = everRenounced,
    recordChanges' = Set(),
    last' = { caller: from, kind: "transfer", res: OK },
  }

  action step = {
    nondet caller = CALLERS.oneOf()
    nondet from = HOLDERS.oneOf()
    nondet dest = HOLDERS.union(Set(ESCROW)).oneOf()
    nondet s = STRS.oneOf()
    nondet recipient = RECIPIENTS.oneOf()
    nondet a = IDS.oneOf()
    nondet b = IDS.oneOf()
    nondet n = 0.to(2).oneOf()
    val ids = if (n == 0) [] else if (n == 1) [a] else [a, b]
    any {
      sendNft(from, s, recipient),
      spoofReceive(caller, from, s, recipient),
      emergencyUnlock(caller, ids),
      renounceAdmin(caller),
      transferNft(from, s, dest),
    }
  }

  // a record only exists while the escrow really holds that kid
  val recordMeansHeld = IDS.forall(t => record.get(t) != NONE implies holder.get(idStr(t)) == ESCROW)

  // record and refund address live and die together
  val recordIffSender = IDS.forall(t => (record.get(t) == NONE) == (sender.get(t) == NONE))

  // every record is a 20 byte non zero address, so BadBridge can always mint it
  val recordsClaimable = IDS.forall(t => Set(NONE, "0xaa", "0xbb").contains(record.get(t)))

  // a record is written once and only ever cleared, never overwritten with someone else
  val recordsWriteOnce = recordChanges.forall(c => c._1 == NONE or c._2 == NONE)

  // only the cw721 can create records, only the admin can unlock or renounce
  val onlyCw721Records = (last.kind == "receive" and last.res.ok) implies last.caller == CW721
  val onlyAdmin = (Set("unlock", "renounce").contains(last.kind) and last.res.ok) implies last.caller == ADMIN

  // once renounced, the admin never comes back
  val adminGoneForever = everRenounced implies admin == NONE

  val safety = recordMeansHeld and recordIffSender and recordsClaimable and recordsWriteOnce
    and onlyCw721Records and onlyAdmin and adminGoneForever

  // Witnesses. Should be violated, so we know these states are reachable.
  val witnessNoRecord = IDS.forall(t => record.get(t) == NONE)
  val witnessNoUnlock = not(last.kind == "unlock" and last.res.ok and recordChanges.size() > 0)
  val witnessNoRenounce = not(everRenounced)
}

// what's in lib.rs
module escrowProd {
  import escrow(GUARDS = true).*
}

// caller checks removed. Should break onlyCw721Records, onlyAdmin and recordMeansHeld.
module escrowNoGuards {
  import escrow(GUARDS = false).*
}
