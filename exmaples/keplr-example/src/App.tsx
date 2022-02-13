import './App.css';
import {useEffect, useState} from "react"
import {
  BestRouteResponse, CosmosTransaction,
  MetaResponse,
  RangoClient,
  TransactionStatus,
  TransactionStatusResponse,
  WalletRequiredAssets
} from "rango-sdk"
import {executeCosmosTransaction, getKeplr, prettyAmount, sleep} from "./utils"


export const App = () => {
  const RANGO_API_KEY = '' // put your RANGO-API-KEY here

  const rangoClient = new RangoClient(RANGO_API_KEY)
  const [tokensMeta, setTokenMeta] = useState<MetaResponse | null>()
  const [inputAmount, setInputAmount] = useState<string>("0.1")
  const [bestRoute, setBestRoute] = useState<BestRouteResponse | null>()
  const [txStatus, setTxStatus] = useState<TransactionStatusResponse | null>(null)
  const [requiredAssets, setRequiredAssets] = useState<WalletRequiredAssets[]>([])
  const [loadingMeta, setLoadingMeta] = useState<boolean>(true)
  const [loadingSwap, setLoadingSwap] = useState<boolean>(false)
  const [error, setError] = useState<string>("")

  useEffect(() => {
    setLoadingMeta(true)
    // Meta provides all blockchains, tokens and swappers information supported by Rango
    rangoClient.getAllMetadata().then((meta) => {
      setTokenMeta(meta)
      setLoadingMeta(false)
    })
  }, [])

  const ustIbcAddress = 'ibc/be1bb42d4be3c30d50b68d7c41db4dfce9678e8ef8c539f6e6a9345048894fcc'
  const ustTokenInOsmosis = tokensMeta?.tokens.find(t => t.blockchain === "OSMOSIS" && t.address === ustIbcAddress)
  const osmoToken = tokensMeta?.tokens.find(t => t.blockchain === "OSMOSIS" && t.address === null && t.symbol === 'OSMO')


  const getUserWallet = async () => {
    const cosmosPopularChains: { name: string; chainId: string }[] = [
      { name: 'COSMOS', chainId: 'cosmoshub-4' },
      { name: 'OSMOSIS', chainId: 'osmosis-1' },
      { name: 'AKASH', chainId: 'akashnet-2', },
      { name: 'SIF', chainId: 'sifchain-1' },
      { name: 'IRIS', chainId: 'irishub-1' },
      { name: 'CRYPTO_ORG', chainId: 'crypto-org-chain-mainnet-1' },
      { name: 'PERSISTENCE', chainId: 'core-1' },
      { name: 'REGEN', chainId: 'regen-1' },
      { name: 'SENTINEL', chainId: 'sentinelhub-2' },
      { name: 'TERRA', chainId: 'columbus-5' },
    ]
    const chainIds = cosmosPopularChains.map(chainInfo => chainInfo.chainId)
    const keplr = await getKeplr()
    if (!keplr) return []
    await keplr.enable(chainIds)
    let connectedWallets = []
    for (let chain of cosmosPopularChains) {
      const offlineSigner = await keplr.getOfflineSigner(chain.chainId)
      const accounts = await offlineSigner?.getAccounts()
      if (!!accounts && accounts.length > 0) {
        const address = accounts.map((account: { address: string }) => { return account.address })
        connectedWallets.push({ blockchain: chain.name, addresses: address, })
      }
    }
    return connectedWallets
  }

  const swap = async () => {
    setError("")
    setBestRoute(null)
    setTxStatus(null)
    setRequiredAssets([])
    let connectedWallets = []
    try {
      connectedWallets = await getUserWallet()
    } catch (err) {
      setError('Error connecting to Keplr. Please check Keplr and try again.')
      return
    }

    if (!connectedWallets || connectedWallets.length === 0) {
      setError(`Could not get wallet address.`)
      return
    }
    if (!inputAmount) {
      setError(`Set input amount`)
      return
    }
    if (!ustTokenInOsmosis || !osmoToken)
      return

    setLoadingSwap(true)

    const from = {blockchain: ustTokenInOsmosis?.blockchain, symbol: ustTokenInOsmosis?.symbol, address: ustTokenInOsmosis.address}
    const to = {blockchain: osmoToken?.blockchain, symbol: osmoToken?.symbol, address: osmoToken.address}
    const selectedWallets =  {OSMOSIS: connectedWallets.find((wallet) => wallet.blockchain === 'OSMOSIS')?.addresses[0] || '',}

    // If you just want to show route to user, set checkPrerequisites: false.
    // Also for multi steps swap, it is faster to get route first with {checkPrerequisites: false} and if users confirms.
    // check his balance with {checkPrerequisites: true} in another get best route request
    const bestRoute = await rangoClient.getBestRoute({
      amount: inputAmount,
      affiliateRef: null,
      checkPrerequisites: true,
      connectedWallets,
      from,
      selectedWallets,
      to,
    })
    setBestRoute(bestRoute)

    console.log({bestRoute})
    if (!bestRoute || !bestRoute?.result || !bestRoute?.result?.swaps || bestRoute.result?.swaps?.length === 0) {
      setError(`Invalid route response from server, please try again.`)
      setLoadingSwap(false)
      return
    }

    const requiredCoins =
      bestRoute.validationStatus?.flatMap(v => v.wallets.flatMap(w => w.requiredAssets)) || []
    setRequiredAssets(requiredCoins)
    const hasEnoughBalance = requiredCoins?.map(it => it.ok).reduce((a, b) => a && b)

    if (!hasEnoughBalance) {
      setError(`Not enough balance or fee!`)
      setLoadingSwap(false)
      return
    }
    else if (bestRoute) {
      await executeRoute(bestRoute)
    }
  }

  const executeRoute = async (routeResponse: BestRouteResponse) => {
    // In multi step swaps, you should loop over routeResponse.route array and create transaction per each item
    let cosmosTransaction
    try {
      const transactionResponse = await rangoClient.createTransaction({
        requestId: routeResponse.requestId,
        step: 1, // In this example, we assumed that route has only one step
        userSettings: { 'slippage': '1' },
        validations: { balance: true, fee: true },
      })

      // in general case, you should check transaction type and call related provider to sign and send tx
      cosmosTransaction = transactionResponse.transaction as CosmosTransaction

      const txHash = await executeCosmosTransaction(cosmosTransaction)
      const txStatus = await checkTransactionStatusSync(txHash, routeResponse, rangoClient)
      console.log("transaction finished", {txStatus})
      setLoadingSwap(false)
    } catch (e) {
      let rawMessage = (JSON.stringify(e)).substring(0, 90) + '...'
      if (e instanceof Error) rawMessage = e.message
      setLoadingSwap(false)
      setError(rawMessage)
      // report transaction failure to server if something went wrong in client for signing and sending the transaction
      await rangoClient.reportFailure({
        data: { message: rawMessage },
        eventType: 'TX_FAIL',
        requestId: routeResponse.requestId,
      })
    }
  }

  const checkTransactionStatusSync = async (txHash: string, bestRoute: BestRouteResponse, rangoClient: RangoClient) => {
    while (true) {
      const txStatus = await rangoClient.checkStatus({
        requestId: bestRoute.requestId,
        step: 1,
        txId: txHash,
      })
      setTxStatus(txStatus)
      console.log({txStatus})
      if (!!txStatus.status && [TransactionStatus.FAILED, TransactionStatus.SUCCESS].includes(txStatus.status)) {
        // for some swappers (e.g. harmony bridge), it needs more than one transaction to be signed for one single step
        // swap. In these cases, you need to check txStatus.newTx and make sure it's null before going to the next step.
        // If it's not null, you need to use that to create next transaction of this step.
        return txStatus
      }
      await sleep(3000)
    }
  }

  const swapperLogo = tokensMeta?.swappers.find(sw => sw.id === bestRoute?.result?.swaps[0].swapperId)?.logo

  return (
    <div className="container">
      {!RANGO_API_KEY && (
        <div className='red-text'><b>Set RANGO_API_KEY inside App.tsx to make it work!</b></div>
      )}
      <div className="tokens-container">
        <div className="from">
          {loadingMeta && (<div className="loading"/>)}
          {!loadingMeta && (<img src={ustTokenInOsmosis?.image} alt="USDT" height="50px"/>)}
          <div>
            <input
              type="number"
              className="from-amount"
              value={inputAmount}
              onChange={(e) => {
                setInputAmount(e.target.value)
              }}
              min="0.01"
              step="0.01"
            />
          </div>
          <div className="symbol">{ustTokenInOsmosis?.symbol}</div>
          <div className="blockchain">from {ustTokenInOsmosis?.blockchain}</div>
        </div>
        <div className="swap-details-container">
          <div className="swap-details">
            {!!requiredAssets && requiredAssets.length > 0 && (
              <div>
                Required Balance Check:
                {requiredAssets.map((item, index) => (
                  <div key={index}>+ {item.asset.symbol},
                    type: {item.reason},
                    required: {prettyAmount(item.requiredAmount)},
                    current: {prettyAmount(item.currentAmount)},
                    enough: {item.ok ? 'yes' : 'no'}
                  </div>
                ))}
              </div>
            )}
            <img src="./img/arrow.png" className="arrow" alt="to"/>
            {bestRoute && <div className='green-text'>
              {swapperLogo && (<img src={swapperLogo} alt="swapper logo" width={50}/>)} <br/>
              {bestRoute?.result?.swaps[0].swapperId}
            </div>}
            {txStatus && (
              <div>
                <br/>
                <div>status: {txStatus.status || TransactionStatus.RUNNING}</div>
                <div>details: {txStatus.extraMessage || '-'}</div>
                {txStatus.explorerUrl?.map((item) => (
                    <div><a href={item.url}>{item.description || "Tx Hash"}</a></div>
                  )
                )}
                <br/>
              </div>
            )}
            {!!error && (<div className="error-message">{error}</div>)}
          </div>
          <button id="swap" onClick={swap} disabled={loadingMeta || loadingSwap}>swap</button>
        </div>
        <div className="to">
          {loadingMeta && (<div className="loading"/>)}
          {!loadingMeta && (<img src={osmoToken?.image} alt="Matic" height="50px"/>)}
          <div className="amount green-text">{bestRoute?.result?.outputAmount || "?"}</div>
          <div className="symbol">{osmoToken?.symbol}</div>
          <div className="blockchain">to {osmoToken?.blockchain}</div>
        </div>
      </div>
    </div>
  )
}

export default App
