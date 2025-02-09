import { useToast } from '@chakra-ui/react'
import { toAssetId } from '@shapeshiftoss/caip'
import { WithdrawType } from '@shapeshiftoss/types'
import {
  Field,
  Withdraw as ReusableWithdraw,
  WithdrawValues,
} from 'features/defi/components/Withdraw/Withdraw'
import {
  DefiParams,
  DefiQueryParams,
  DefiStep,
} from 'features/defi/contexts/DefiManagerProvider/DefiCommon'
import { useFoxy } from 'features/defi/contexts/FoxyProvider/FoxyProvider'
import { useContext } from 'react'
import { FormProvider, useForm } from 'react-hook-form'
import { useTranslate } from 'react-polyglot'
import { StepComponentProps } from 'components/DeFi/components/Steps'
import { useBrowserRouter } from 'hooks/useBrowserRouter/useBrowserRouter'
import { BigNumber, bn, bnOrZero } from 'lib/bignumber/bignumber'
import { logger } from 'lib/logger'
import {
  selectAssetById,
  selectMarketDataById,
  selectPortfolioCryptoBalanceByAssetId,
} from 'state/slices/selectors'
import { useAppSelector } from 'state/store'

import { FoxyWithdrawActionType } from '../WithdrawCommon'
import { WithdrawContext } from '../WithdrawContext'
import { WithdrawTypeField } from './WithdrawType'

export type FoxyWithdrawValues = {
  [Field.WithdrawType]: WithdrawType
} & WithdrawValues

const moduleLogger = logger.child({ namespace: ['FoxyWithdraw:Withdraw'] })

export const Withdraw: React.FC<StepComponentProps> = ({ onNext }) => {
  const { foxy: api } = useFoxy()
  const { state, dispatch } = useContext(WithdrawContext)
  const translate = useTranslate()
  const { query, history: browserHistory } = useBrowserRouter<DefiQueryParams, DefiParams>()
  const { chainId, contractAddress, rewardId, assetReference } = query
  const toast = useToast()

  const methods = useForm<FoxyWithdrawValues>({ mode: 'onChange' })
  const { setValue, watch } = methods

  const withdrawTypeValue = watch(Field.WithdrawType)

  const assetNamespace = 'erc20'
  // Reward Asset info
  const assetId = toAssetId({
    chainId,
    assetNamespace,
    assetReference: rewardId,
  })
  const asset = useAppSelector(state => selectAssetById(state, assetId))
  const marketData = useAppSelector(state => selectMarketDataById(state, assetId))

  // Staking Asset Info
  const stakingAssetId = toAssetId({
    chainId,
    assetNamespace,
    assetReference,
  })
  const stakingAsset = useAppSelector(state => selectAssetById(state, stakingAssetId))

  // user info
  const balance = useAppSelector(state => selectPortfolioCryptoBalanceByAssetId(state, { assetId }))

  if (!state || !dispatch) return null

  const getWithdrawGasEstimate = async (withdraw: FoxyWithdrawValues) => {
    if (!state.userAddress || !rewardId || !api) return
    try {
      const [gasLimit, gasPrice] = await Promise.all([
        api.estimateWithdrawGas({
          tokenContractAddress: rewardId,
          contractAddress,
          amountDesired: bnOrZero(
            bn(withdraw.cryptoAmount).times(`1e+${asset.precision}`),
          ).decimalPlaces(0),
          userAddress: state.userAddress,
          type: withdraw.withdrawType,
        }),
        api.getGasPrice(),
      ])
      return bnOrZero(bn(gasPrice).times(gasLimit)).toFixed(0)
    } catch (error) {
      moduleLogger.error(
        { fn: 'getWithdrawGasEstimate', error },
        'Error getting deposit gas estimate',
      )
      const fundsError =
        error instanceof Error && error.message.includes('Not enough funds in reserve')
      toast({
        position: 'top-right',
        description: fundsError
          ? translate('defi.notEnoughFundsInReserve')
          : translate('common.somethingWentWrong'),
        title: translate('common.somethingWentWrong'),
        status: 'error',
      })
    }
  }

  const handleContinue = async (formValues: FoxyWithdrawValues) => {
    if (!state.userAddress || !api) return
    // set withdraw state for future use
    dispatch({
      type: FoxyWithdrawActionType.SET_WITHDRAW,
      payload: formValues,
    })
    dispatch({
      type: FoxyWithdrawActionType.SET_LOADING,
      payload: true,
    })
    try {
      // Check is approval is required for user address
      const _allowance = await api.allowance({
        tokenContractAddress: rewardId,
        contractAddress,
        userAddress: state.userAddress,
      })

      const allowance = bnOrZero(bn(_allowance).div(`1e+${asset.precision}`))

      // Skip approval step if user allowance is greater than requested deposit amount
      if (allowance.gte(formValues.cryptoAmount)) {
        const estimatedGasCrypto = await getWithdrawGasEstimate(formValues)
        if (!estimatedGasCrypto) return
        dispatch({
          type: FoxyWithdrawActionType.SET_WITHDRAW,
          payload: { estimatedGasCrypto },
        })
        onNext(DefiStep.Confirm)
        dispatch({
          type: FoxyWithdrawActionType.SET_LOADING,
          payload: false,
        })
      } else {
        const estimatedGasCrypto = await getApproveGasEstimate()
        if (!estimatedGasCrypto) return
        dispatch({
          type: FoxyWithdrawActionType.SET_APPROVE,
          payload: { estimatedGasCrypto },
        })
        onNext(DefiStep.Approve)
        dispatch({
          type: FoxyWithdrawActionType.SET_LOADING,
          payload: false,
        })
      }
    } catch (error) {
      moduleLogger.error({ fn: 'handleContinue', error }, 'Error with withdraw')
      dispatch({
        type: FoxyWithdrawActionType.SET_LOADING,
        payload: false,
      })
      toast({
        position: 'top-right',
        description: translate('common.somethingWentWrongBody'),
        title: translate('common.somethingWentWrong'),
        status: 'error',
      })
    }
  }

  const getApproveGasEstimate = async () => {
    if (!state.userAddress || !rewardId || !api) return
    try {
      const [gasLimit, gasPrice] = await Promise.all([
        api.estimateApproveGas({
          tokenContractAddress: rewardId,
          contractAddress,
          userAddress: state.userAddress,
        }),
        api.getGasPrice(),
      ])
      return bnOrZero(bn(gasPrice).times(gasLimit)).toFixed(0)
    } catch (error) {
      moduleLogger.error(error, { fn: 'getApproveEstimate' }, 'getApproveEstimate error')
      toast({
        position: 'top-right',
        description: translate('common.somethingWentWrongBody'),
        title: translate('common.somethingWentWrong'),
        status: 'error',
      })
    }
  }

  const handleCancel = () => {
    browserHistory.goBack()
  }

  const handlePercentClick = (percent: number) => {
    const cryptoAmount = bnOrZero(cryptoAmountAvailable)
      .times(percent)
      .dp(asset.precision, BigNumber.ROUND_DOWN)
    const fiatAmount = bnOrZero(cryptoAmount).times(marketData.price)
    setValue(Field.FiatAmount, fiatAmount.toString(), {
      shouldValidate: true,
    })
    setValue(Field.CryptoAmount, cryptoAmount.toString(), {
      shouldValidate: true,
    })
  }

  const validateCryptoAmount = (value: string) => {
    const crypto = bnOrZero(bn(balance).div(`1e+${asset.precision}`))
    const _value = bnOrZero(value)
    const hasValidBalance = crypto.gt(0) && _value.gt(0) && crypto.gte(value)
    if (_value.isEqualTo(0)) return ''
    return hasValidBalance || 'common.insufficientFunds'
  }

  const validateFiatAmount = (value: string) => {
    const crypto = bnOrZero(bn(balance).div(`1e+${asset.precision}`))
    const fiat = crypto.times(bnOrZero(marketData?.price))
    const _value = bnOrZero(value)
    const hasValidBalance = fiat.gt(0) && _value.gt(0) && fiat.gte(value)
    if (_value.isEqualTo(0)) return ''
    return hasValidBalance || 'common.insufficientFunds'
  }

  const cryptoAmountAvailable = bnOrZero(bn(balance).div(`1e+${asset?.precision}`))
  const fiatAmountAvailable = bnOrZero(bn(cryptoAmountAvailable).times(bnOrZero(marketData?.price)))

  return (
    <FormProvider {...methods}>
      <ReusableWithdraw
        asset={stakingAsset}
        cryptoAmountAvailable={cryptoAmountAvailable.toPrecision()}
        cryptoInputValidation={{
          required: true,
          validate: { validateCryptoAmount },
        }}
        fiatAmountAvailable={fiatAmountAvailable.toString()}
        fiatInputValidation={{
          required: true,
          validate: { validateFiatAmount },
        }}
        marketData={marketData}
        onCancel={handleCancel}
        onContinue={handleContinue}
        isLoading={state.loading}
        handlePercentClick={handlePercentClick}
        disableInput={withdrawTypeValue === WithdrawType.INSTANT}
        percentOptions={[0.25, 0.5, 0.75, 1]}
      >
        <WithdrawTypeField
          asset={stakingAsset}
          handlePercentClick={handlePercentClick}
          feePercentage={bnOrZero(state.foxyFeePercentage).toString()}
        />
      </ReusableWithdraw>
    </FormProvider>
  )
}
