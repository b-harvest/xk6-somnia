package ethgo

import (
	"encoding/hex"
	"fmt"
	"github.com/umbracle/ethgo"
	"github.com/umbracle/ethgo/wallet"
	"go.k6.io/k6/js/modules"
	"math/big"
)

type Module struct{}

// Ensure the module is loaded
func init() {
	m := &Module{}

	modules.Register("k6/x/ethgo", m)
}

// JS: ethgo.signLegacyTx({nonce, gasPrice, gas, to, value, data, chainId}, privKeyHex) → hex string
func (m *Module) SignLegacyTx(tx map[string]interface{}, privKeyHex string) (string, error) {
	t := &ethgo.Transaction{
		Type: ethgo.TransactionLegacy,
	}
	// Required fields
	if v, ok := tx["nonce"]; ok {
		t.Nonce = uint64(intFromIface(v))
	}
	if v, ok := tx["gasPrice"]; ok {
		t.GasPrice = uint64(intFromIface(v))
	}
	if v, ok := tx["gas"]; ok {
		t.Gas = uint64(intFromIface(v))
	}
	if v, ok := tx["to"]; ok {
		addr := ethgo.HexToAddress(v.(string))
		t.To = &addr
	}
	if v, ok := tx["value"]; ok {
		t.Value = big.NewInt(intFromIface(v))
	}
	if v, ok := tx["data"]; ok {
		dataHex := v.(string)
		if len(dataHex) > 2 && dataHex[:2] == "0x" {
			dataHex = dataHex[2:]
		}
		d, _ := hex.DecodeString(dataHex)
		t.Input = d
	}
	if v, ok := tx["chainId"]; ok {
		t.ChainID = big.NewInt(intFromIface(v))
	}

	pk, err := hex.DecodeString(privKeyHex)
	if err != nil {
		return "", err
	}
	key, err := wallet.NewWalletFromPrivKey(pk)

	signer := wallet.NewEIP155Signer(t.ChainID.Uint64())
	signed, err := signer.SignTx(t, key)
	if err != nil {
		return "", err
	}
	raw, err := signed.MarshalRLPTo(nil)
	if err != nil {
		return "", err
	}
	return "0x" + hex.EncodeToString(raw), nil
}

// JS: ethgo.hexToAddress(str) → "0x.."
func (m *Module) HexToAddress(addr string) string {
	return ethgo.HexToAddress(addr).String()
}

func intFromIface(v interface{}) int64 {
	switch vv := v.(type) {
	case float64:
		return int64(vv)
	case int64:
		return vv
	case int32:
		return int64(vv)
	case uint64:
		return int64(vv)
	case uint32:
		return int64(vv)
	case int:
		return int64(vv)
	case *big.Int:
		return vv.Int64()
	case big.Int:
		return vv.Int64()
	default:
		panic(fmt.Sprintf("unexpected type for int field: %T", v))
	}
}

func (m *Module) PrivateKeyToAddress(privateKeyHex string) (string, error) {

	pk, err := hex.DecodeString(privateKeyHex)
	if err != nil {
		return "", err
	}
	key, err := wallet.NewWalletFromPrivKey(pk)
	if err != nil {
		return "", err
	}
	return key.Address().String(), nil
}
