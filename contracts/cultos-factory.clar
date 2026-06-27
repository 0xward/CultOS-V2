;; CultOS Factory Contract
;; Stacks Mainnet - Bitcoin Layer 2
;;
;; Registers sub-cult deployments on-chain.
;; Deployment fees are forwarded directly to the contract owner (treasury).
;; The owner may also withdraw any STX balance held by the contract itself.

;; --- Constants ---

(define-constant CONTRACT-OWNER tx-sender)

(define-constant ERR-NOT-OWNER        (err u100))
(define-constant ERR-INSUFFICIENT-FEE (err u101))
(define-constant ERR-EMPTY-NAME       (err u102))
(define-constant ERR-EMPTY-TICKER     (err u103))
(define-constant ERR-NO-BALANCE       (err u104))
(define-constant ERR-NAME-TOO-LONG    (err u105))
(define-constant ERR-TICKER-TOO-LONG  (err u106))
(define-constant ERR-TICKER-TAKEN     (err u107))

;; Minimum fee: 0.05 STX (50,000 micro-STX)
(define-constant MIN-FEE u50000)

;; --- Storage ---

(define-data-var cult-count uint u0)

(define-map cults
  { cult-id: uint }
  {
    name:         (string-utf8 64),
    ticker:       (string-utf8 8),
    lore:         (string-utf8 500),
    viral-score:  uint,
    deployer:     principal,
    fee-paid:     uint,
    block-height: uint
  }
)

(define-map registered-tickers
  { ticker: (string-utf8 8) }
  { cult-id: uint }
)

;; --- Public Functions ---

(define-public (register-cult
  (name        (string-utf8 64))
  (ticker      (string-utf8 8))
  (lore        (string-utf8 500))
  (viral-score uint)
  (fee-amount  uint)
)
  (let
    (
      (new-id (+ (var-get cult-count) u1))
      (caller tx-sender)
    )
    (asserts! (>= fee-amount MIN-FEE)  ERR-INSUFFICIENT-FEE)
    (asserts! (> (len name) u0)        ERR-EMPTY-NAME)
    (asserts! (<= (len name) u64)      ERR-NAME-TOO-LONG)
    (asserts! (> (len ticker) u0)      ERR-EMPTY-TICKER)
    (asserts! (<= (len ticker) u8)     ERR-TICKER-TOO-LONG)
    (asserts! (is-none (map-get? registered-tickers { ticker: ticker })) ERR-TICKER-TAKEN)
    (try! (stx-transfer? fee-amount caller CONTRACT-OWNER))
    (map-set cults
      { cult-id: new-id }
      {
        name:         name,
        ticker:       ticker,
        lore:         lore,
        viral-score:  viral-score,
        deployer:     caller,
        fee-paid:     fee-amount,
        block-height: block-height
      }
    )
    (map-set registered-tickers { ticker: ticker } { cult-id: new-id })
    (var-set cult-count new-id)
    (ok new-id)
  )
)

(define-public (withdraw)
  (let
    (
      (balance (stx-get-balance (as-contract tx-sender)))
    )
    (asserts! (is-eq tx-sender CONTRACT-OWNER) ERR-NOT-OWNER)
    (asserts! (> balance u0)                   ERR-NO-BALANCE)
    (try! (as-contract (stx-transfer? balance tx-sender CONTRACT-OWNER)))
    (ok balance)
  )
)

;; --- Read-Only Functions ---

(define-read-only (get-cult (cult-id uint))
  (map-get? cults { cult-id: cult-id })
)

(define-read-only (get-cult-count)
  (ok (var-get cult-count))
)

(define-read-only (get-balance)
  (ok (stx-get-balance (as-contract tx-sender)))
)

(define-read-only (get-owner)
  (ok CONTRACT-OWNER)
)

(define-read-only (is-ticker-available (t (string-utf8 8)))
  (is-none (map-get? registered-tickers { ticker: t }))
)
