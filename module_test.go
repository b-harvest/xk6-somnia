package ethgo

import (
	"bytes"
	"encoding/hex"
	"testing"

	"github.com/umbracle/ethgo/wallet"
)

func TestHexToAddress(t *testing.T) {
	m := &Module{}
	input := "0x5FbDB2315678afecb367f032d93F642f64180aa3"
	expected := "0x5fbdb2315678afecb367f032d93f642f64180aa3"
	got := m.HexToAddress(input)
	if got != expected {
		t.Errorf("HexToAddress(%s) = %s; want %s", input, got, expected)
	}
}

func TestPrivateKeyToAddress(t *testing.T) {
	// Generate a deterministic 32-byte private key (all bytes = 0x01)
	pkBytes := bytes.Repeat([]byte{1}, 32)
	pkHex := hex.EncodeToString(pkBytes)

	m := &Module{}
	got, err := m.PrivateKeyToAddress(pkHex)
	if err != nil {
		t.Fatalf("PrivateKeyToAddress error: %v", err)
	}

	// Derive expected address via direct wallet call
	w, err := wallet.NewWalletFromPrivKey(pkBytes)
	if err != nil {
		t.Fatalf("wallet.NewWalletFromPrivKey error: %v", err)
	}
	expected := w.Address().String()
	if got != expected {
		t.Errorf("PrivateKeyToAddress returned %s; want %s", got, expected)
	}
}

func TestSignLegacyTx(t *testing.T) {
	// Sample transaction parameters
	tx := map[string]interface{}{
		"to":      "0x5fbdb2315678afecb367f032d93f642f64180aa3",
		"value":   1000000000,
		"chainId": 50312,
		"gas":     6 * 1e9,
	}

	// Same deterministic private key as above
	pkBytes := bytes.Repeat([]byte{1}, 32)
	pkHex := hex.EncodeToString(pkBytes)

	m := &Module{}
	rawHex, err := m.SignLegacyTx(tx, pkHex)
	if err != nil {
		t.Fatalf("SignLegacyTx error: %v", err)
	}

	// Should start with 0x
	if len(rawHex) < 3 || rawHex[:2] != "0x" {
		t.Errorf("signed tx hex missing prefix '0x': %s", rawHex)
	}

	// Hex decode should succeed
	rawBytes, err := hex.DecodeString(rawHex[2:])
	if err != nil {
		t.Errorf("failed to decode signed tx hex: %v", err)
	}
	if len(rawBytes) == 0 {
		t.Error("decoded tx bytes is empty")
	}
	t.Logf("raw bytes: %s", rawHex)
}
