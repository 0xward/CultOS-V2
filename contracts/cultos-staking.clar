;; ============================================================
;; CultOS Staking Contract  Ritual Altar
;; Network : Stacks Mainnet (Bitcoin Layer 2)
;; Token   : SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS
;; Version : 2 (Clarity v2)
;; ------------------------------------------------------------
;; PURPOSE:
;; This contract allows $CultOS token holders to "lock" (stake)
;; their tokens for a fixed period of time in exchange for:
;;   - XP multipliers (used for rank progression in CultOS)
;;   - A share of the global deployment fee reward pool
;;
;; HOW IT WORKS:
;; 1. User calls (stake)  sends $CultOS to this contract
;;    and their lock record is saved on-chain.
;; 2. After the lock period expires, user calls (unstake)
;;     their $CultOS is returned to their wallet.
;; 3. Owner calls (fund-rewards) to deposit $CultOS into the
;;    rewards pool (funded from sub-cult deployment fees).
;; ============================================================

;; Import the SIP-010 fungible token standard trait.
;; This ensures we only interact with valid Stacks fungible tokens.
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; ============================================================
;; CONSTANTS
;; ============================================================

;; The wallet address that deployed this contract.
;; Only this address can call admin functions like (fund-rewards).
(define-constant CONTRACT-OWNER tx-sender)

;; The ONLY token accepted by this staking contract.
;; Prevents anyone from staking fake or wrong tokens.
(define-constant CULTOS-TOKEN 'SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS)

;; Tier IDs  three devotion levels a user can choose from.
(define-constant TIER-NEOPHYTE  u1)   ;; Beginner: 30 days lock
(define-constant TIER-ADEPT     u2)   ;; Mid: 90 days lock
(define-constant TIER-SOVEREIGN u3)   ;; Max: 180 days lock

;; Lock durations measured in Stacks blocks.
;; Stacks produces ~1 block every 10 minutes = ~144 blocks/day.
(define-constant DURATION-NEOPHYTE  u4320)   ;; 30 days
(define-constant DURATION-ADEPT     u12960)  ;; 90 days
(define-constant DURATION-SOVEREIGN u25920)  ;; 180 days

;; Minimum stake amounts in micro-$CultOS (6 decimal places).
;; Example: u100000000 = 100 $CultOS (100 * 10^6)
(define-constant MIN-NEOPHYTE  u100000000)   ;; 100 $CultOS
(define-constant MIN-ADEPT     u500000000)   ;; 500 $CultOS
(define-constant MIN-SOVEREIGN u2000000000)  ;; 2,000 $CultOS

;; Error codes returned when something goes wrong.
;; These appear in the explorer as (err uXXX).
(define-constant ERR-NOT-OWNER      (err u200)) ;; Caller is not contract owner
(define-constant ERR-INVALID-TIER   (err u201)) ;; Tier ID is not 1, 2, or 3
(define-constant ERR-BELOW-MINIMUM  (err u202)) ;; Amount is below tier minimum
(define-constant ERR-ALREADY-STAKED (err u203)) ;; Wallet already has an active stake
(define-constant ERR-NO-STAKE       (err u204)) ;; Wallet has no stake to unstake
(define-constant ERR-LOCK-ACTIVE    (err u205)) ;; Lock period has not expired yet
(define-constant ERR-WRONG-TOKEN    (err u207)) ;; Token passed is not $CultOS

;; ============================================================
;; STATE VARIABLES
;; These track global numbers across all stakers.
;; ============================================================

;; Total $CultOS currently locked inside this contract (micro units).
(define-data-var total-locked uint u0)

;; Number of wallets currently staking.
(define-data-var staker-count uint u0)

;; $CultOS available as rewards, funded by the contract owner.
(define-data-var rewards-pool uint u0)

;; ============================================================
;; STAKER MAP
;; Stores each wallet's staking record.
;; Key   : { staker: principal }  the wallet address
;; Value : all details about their current lock
;; ============================================================
(define-map stakes
  { staker: principal }
  {
    amount:        uint,  ;; How many micro-$CultOS they locked
    tier:          uint,  ;; Which tier (1=Neophyte, 2=Adept, 3=Sovereign)
    lock-start:    uint,  ;; Block height when stake began
    lock-end:      uint,  ;; Block height when lock expires (can unstake after this)
    multiplier-bp: uint,  ;; XP yield multiplier in basis points (12000 = 1.2x)
    xp-earned:     uint,  ;; Total XP accumulated (future use)
    last-claimed:  uint   ;; Last block rewards were claimed (future use)
  }
)

;; ============================================================
;; PRIVATE HELPERS
;; Internal functions used by public functions below.
;; ============================================================

;; Returns the block duration for a given tier.
(define-private (get-tier-duration (tier uint))
  (if (is-eq tier TIER-NEOPHYTE) DURATION-NEOPHYTE
  (if (is-eq tier TIER-ADEPT)    DURATION-ADEPT
                                 DURATION-SOVEREIGN)))

;; Returns the minimum stake amount for a given tier.
(define-private (get-tier-minimum (tier uint))
  (if (is-eq tier TIER-NEOPHYTE) MIN-NEOPHYTE
  (if (is-eq tier TIER-ADEPT)    MIN-ADEPT
                                 MIN-SOVEREIGN)))

;; Returns the XP multiplier in basis points for a given tier.
;; Basis points: 10000 = 1.0x, 12000 = 1.2x, 35000 = 3.5x
(define-private (get-tier-multiplier-bp (tier uint))
  (if (is-eq tier TIER-NEOPHYTE) u12000
  (if (is-eq tier TIER-ADEPT)    u18000
                                 u35000)))

;; ============================================================
;; PUBLIC FUNCTIONS
;; These can be called by any wallet.
;; ============================================================

;; STAKE
;; Lock $CultOS tokens into this contract for a chosen tier.
;; The tokens leave the user's wallet and sit in this contract
;; until the lock period expires.
;;
;; Arguments:
;;   token  must be the $CultOS SIP-010 contract
;;   amount  how many micro-$CultOS to lock
;;   tier    1 (Neophyte), 2 (Adept), or 3 (Sovereign)
(define-public (stake (token <sip-010-trait>) (amount uint) (tier uint))
  (let
    ((caller        tx-sender)
     (existing      (map-get? stakes { staker: caller }))
     (duration      (get-tier-duration tier))
     (minimum       (get-tier-minimum tier))
     (multiplier-bp (get-tier-multiplier-bp tier))
     (lock-start    block-height)
     (lock-end      (+ block-height duration)))

    ;; Must use the real $CultOS token, nothing else
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    ;; Tier must be 1, 2, or 3
    (asserts! (or (is-eq tier TIER-NEOPHYTE)
                  (is-eq tier TIER-ADEPT)
                  (is-eq tier TIER-SOVEREIGN)) ERR-INVALID-TIER)
    ;; Amount must meet tier minimum
    (asserts! (>= amount minimum) ERR-BELOW-MINIMUM)
    ;; Cannot stake if already staking (one stake per wallet)
    (asserts! (is-none existing) ERR-ALREADY-STAKED)

    ;; Transfer $CultOS from user's wallet to this contract
    (try! (contract-call? token transfer amount caller (as-contract tx-sender) none))

    ;; Save the stake record on-chain
    (map-set stakes { staker: caller }
      { amount:        amount,
        tier:          tier,
        lock-start:    lock-start,
        lock-end:      lock-end,
        multiplier-bp: multiplier-bp,
        xp-earned:     u0,
        last-claimed:  lock-start })

    ;; Update global counters
    (var-set total-locked (+ (var-get total-locked) amount))
    (var-set staker-count (+ (var-get staker-count) u1))

    (ok { tier: tier, amount: amount, lock-end: lock-end, multiplier-bp: multiplier-bp })))

;; UNSTAKE
;; Return locked $CultOS back to the user's wallet.
;; Can only be called AFTER the lock-end block has passed.
;;
;; Arguments:
;;   token  must be the $CultOS SIP-010 contract
(define-public (unstake (token <sip-010-trait>))
  (let
    ((caller             tx-sender)
     (s                  (unwrap! (map-get? stakes { staker: caller }) ERR-NO-STAKE))
     (amount             (get amount s))
     (contract-principal (as-contract tx-sender)))  ;; this contract's own address

    ;; Must use the real $CultOS token
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    ;; Lock period must be over
    (asserts! (>= block-height (get lock-end s)) ERR-LOCK-ACTIVE)

    ;; Send $CultOS from this contract back to the user
    (try! (contract-call? token transfer amount contract-principal caller none))

    ;; Delete their stake record
    (map-delete stakes { staker: caller })

    ;; Update global counters
    (var-set total-locked (if (>= (var-get total-locked) amount)
                             (- (var-get total-locked) amount) u0))
    (var-set staker-count (if (> (var-get staker-count) u0)
                             (- (var-get staker-count) u1) u0))

    (ok { unstaked: amount })))

;; FUND-REWARDS (owner only)
;; Deposit $CultOS into the rewards pool.
;; Called by the contract owner to distribute revenue from
;; sub-cult deployment fees back to stakers.
;;
;; Arguments:
;;   token   must be the $CultOS SIP-010 contract
;;   amount  how many micro-$CultOS to add to the pool
(define-public (fund-rewards (token <sip-010-trait>) (amount uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    (try! (contract-call? token transfer amount tx-sender (as-contract tx-sender) none))
    (var-set rewards-pool (+ (var-get rewards-pool) amount))
    (ok amount)))

;; ============================================================
;; READ-ONLY FUNCTIONS
;; These are free to call  no transaction needed.
;; Used by the CultOS frontend to display live stats.
;; ============================================================

;; Get full stake details for any wallet address
(define-read-only (get-stake (staker principal))
  (map-get? stakes { staker: staker }))

;; Total $CultOS locked across all stakers
(define-read-only (get-total-locked)
  (ok (var-get total-locked)))

;; Number of active stakers right now
(define-read-only (get-staker-count)
  (ok (var-get staker-count)))

;; Current size of the rewards pool
(define-read-only (get-rewards-pool)
  (ok (var-get rewards-pool)))

;; Returns the $CultOS token contract address this staking contract uses
(define-read-only (get-token-address)
  (ok CULTOS-TOKEN))

;; Returns true if a wallet's lock is still active, false if expired
(define-read-only (is-locked (staker principal))
  (match (map-get? stakes { staker: staker })
    s (< block-height (get lock-end s))
    false))

;; How many blocks remain until a wallet can unstake (0 if expired)
(define-read-only (blocks-remaining (staker principal))
  (match (map-get? stakes { staker: staker })
    s (if (>= block-height (get lock-end s))
          u0
          (- (get lock-end s) block-height))
    u0))

;; Returns the XP multiplier in basis points for a wallet.
;; If not staking, returns 10000 (1.0x default).
(define-read-only (get-multiplier (staker principal))
  (match (map-get? stakes { staker: staker })
    s (ok (get multiplier-bp s))
    (ok u10000)))
