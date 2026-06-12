;; CultOS Staking Contract — $CultOS Devotion Locking
;; Stacks Mainnet - Bitcoin Layer 2
;;
;; Token: SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS (LIVE)
;; Allows locking $CultOS for XP multipliers and yield from deployment fee pool.

;; --- Trait Import ---
(use-trait sip-010-trait 'SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE.sip-010-trait-ft-standard.sip-010-trait)

;; --- Constants ---
(define-constant CONTRACT-OWNER tx-sender)
(define-constant CULTOS-TOKEN 'SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS)

;; Tier IDs
(define-constant TIER-NEOPHYTE  u1)
(define-constant TIER-ADEPT     u2)
(define-constant TIER-SOVEREIGN u3)

;; Lock durations in blocks (~144 blocks/day on Stacks)
(define-constant DURATION-NEOPHYTE  u4320)   ;; 30 days
(define-constant DURATION-ADEPT     u12960)  ;; 90 days
(define-constant DURATION-SOVEREIGN u25920)  ;; 180 days

;; Min stake: 100 / 500 / 2000 $CultOS (6 decimals)
(define-constant MIN-NEOPHYTE  u100000000)
(define-constant MIN-ADEPT     u500000000)
(define-constant MIN-SOVEREIGN u2000000000)

;; Error codes
(define-constant ERR-NOT-OWNER       (err u200))
(define-constant ERR-INVALID-TIER    (err u201))
(define-constant ERR-BELOW-MINIMUM   (err u202))
(define-constant ERR-ALREADY-STAKED  (err u203))
(define-constant ERR-NO-STAKE        (err u204))
(define-constant ERR-LOCK-ACTIVE     (err u205))
(define-constant ERR-NO-REWARDS      (err u206))
(define-constant ERR-WRONG-TOKEN     (err u207))

;; --- Storage ---
(define-data-var total-locked  uint u0)
(define-data-var staker-count  uint u0)
(define-data-var rewards-pool  uint u0)

(define-map stakes
  { staker: principal }
  {
    amount:        uint,
    tier:          uint,
    lock-start:    uint,
    lock-end:      uint,
    multiplier-bp: uint,  ;; basis points: 12000=1.2x, 18000=1.8x, 35000=3.5x
    xp-earned:     uint,
    last-claimed:  uint
  }
)

;; --- Private Helpers ---
(define-private (get-tier-duration (tier uint))
  (if (is-eq tier TIER-NEOPHYTE)  DURATION-NEOPHYTE
  (if (is-eq tier TIER-ADEPT)     DURATION-ADEPT
                                  DURATION-SOVEREIGN))
)

(define-private (get-tier-minimum (tier uint))
  (if (is-eq tier TIER-NEOPHYTE)  MIN-NEOPHYTE
  (if (is-eq tier TIER-ADEPT)     MIN-ADEPT
                                  MIN-SOVEREIGN))
)

(define-private (get-tier-multiplier-bp (tier uint))
  (if (is-eq tier TIER-NEOPHYTE)  u12000
  (if (is-eq tier TIER-ADEPT)     u18000
                                  u35000))
)

;; --- Public Functions ---

;; Stake $CultOS into a devotion tier
(define-public (stake (token <sip-010-trait>) (amount uint) (tier uint))
  (let
    (
      (caller        tx-sender)
      (existing      (map-get? stakes { staker: caller }))
      (duration      (get-tier-duration tier))
      (minimum       (get-tier-minimum tier))
      (multiplier-bp (get-tier-multiplier-bp tier))
      (lock-start    block-height)
      (lock-end      (+ block-height duration))
    )
    ;; Validate token is $CultOS
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    ;; Validate tier
    (asserts! (or (is-eq tier TIER-NEOPHYTE)
                  (is-eq tier TIER-ADEPT)
                  (is-eq tier TIER-SOVEREIGN)) ERR-INVALID-TIER)
    ;; Validate amount
    (asserts! (>= amount minimum) ERR-BELOW-MINIMUM)
    ;; No double-staking
    (asserts! (is-none existing) ERR-ALREADY-STAKED)

    ;; Transfer $CultOS from caller to this contract
    (try! (contract-call? token transfer amount caller (as-contract tx-sender) none))

    ;; Record stake
    (map-set stakes { staker: caller }
      {
        amount:        amount,
        tier:          tier,
        lock-start:    lock-start,
        lock-end:      lock-end,
        multiplier-bp: multiplier-bp,
        xp-earned:     u0,
        last-claimed:  lock-start,
      }
    )

    ;; Update globals
    (var-set total-locked (+ (var-get total-locked) amount))
    (var-set staker-count (+ (var-get staker-count) u1))

    (ok { tier: tier, amount: amount, lock-end: lock-end, multiplier-bp: multiplier-bp })
  )
)

;; Unstake after lock expires — returns principal
(define-public (unstake (token <sip-010-trait>))
  (let
    (
      (caller tx-sender)
      (s      (unwrap! (map-get? stakes { staker: caller }) ERR-NO-STAKE))
      (amount (get amount s))
    )
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    (asserts! (>= block-height (get lock-end s)) ERR-LOCK-ACTIVE)

    ;; Return tokens
    (try! (as-contract (contract-call? token transfer amount tx-sender caller none)))

    ;; Cleanup
    (map-delete stakes { staker: caller })
    (var-set total-locked (if (>= (var-get total-locked) amount) (- (var-get total-locked) amount) u0))
    (var-set staker-count (if (> (var-get staker-count) u0) (- (var-get staker-count) u1) u0))

    (ok { unstaked: amount })
  )
)

;; Owner adds to rewards pool (funded from deployment fees)
(define-public (fund-rewards (token <sip-010-trait>) (amount uint))
  (begin
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (is-eq (contract-of token) CULTOS-TOKEN) ERR-WRONG-TOKEN)
    (try! (contract-call? token transfer amount tx-sender (as-contract tx-sender) none))
    (var-set rewards-pool (+ (var-get rewards-pool) amount))
    (ok amount)
  )
)

;; --- Read-Only ---
(define-read-only (get-stake (staker principal))
  (map-get? stakes { staker: staker })
)
(define-read-only (get-total-locked)  (ok (var-get total-locked)))
(define-read-only (get-staker-count)  (ok (var-get staker-count)))
(define-read-only (get-rewards-pool)  (ok (var-get rewards-pool)))
(define-read-only (get-token-address) (ok CULTOS-TOKEN))

(define-read-only (is-locked (staker principal))
  (match (map-get? stakes { staker: staker })
    s (< block-height (get lock-end s))
    false)
)

(define-read-only (blocks-remaining (staker principal))
  (match (map-get? stakes { staker: staker })
    s (if (>= block-height (get lock-end s)) u0 (- (get lock-end s) block-height))
    u0)
)

(define-read-only (get-multiplier (staker principal))
  (match (map-get? stakes { staker: staker })
    s (ok (get multiplier-bp s))
    (ok u10000)) ;; 1.0x default if not staking
)
