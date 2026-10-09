/* Vault cryptography.
   One password -> PBKDF2 (SHA-256) -> AES-GCM key. The password is never stored.
   The vault record keeps only a random salt and a small encrypted check value,
   which is how a later password attempt is verified. */
(function (root) {
  'use strict';

  const ITERATIONS = 600000;
  const CHECK_TEXT = 'logbook-vault-v1';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function available() {
    return !!(root.crypto && root.crypto.subtle && root.crypto.getRandomValues);
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    root.crypto.getRandomValues(bytes);
    return bytes;
  }

  async function deriveKey(password, saltBase64, iterations) {
    const material = await root.crypto.subtle.importKey(
      'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return root.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: fromBase64(saltBase64), iterations: iterations, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /* aad (optional) binds the ciphertext to something, such as a note id,
     so one note's ciphertext can't be swapped into another note. */
  async function encryptText(key, text, aad) {
    const iv = randomBytes(12);
    const params = { name: 'AES-GCM', iv: iv };
    if (aad) params.additionalData = encoder.encode(aad);
    const data = await root.crypto.subtle.encrypt(params, key, encoder.encode(text));
    return { iv: toBase64(iv), data: toBase64(data) };
  }

  async function decryptText(key, blob, aad) {
    const params = { name: 'AES-GCM', iv: fromBase64(blob.iv) };
    if (aad) params.additionalData = encoder.encode(aad);
    const plain = await root.crypto.subtle.decrypt(params, key, fromBase64(blob.data));
    return decoder.decode(plain);
  }

  async function createVault(password, hint) {
    const salt = toBase64(randomBytes(16));
    const key = await deriveKey(password, salt, ITERATIONS);
    const check = await encryptText(key, CHECK_TEXT);
    return {
      vault: {
        v: 1,
        kdf: 'PBKDF2-SHA256',
        iterations: ITERATIONS,
        salt: salt,
        check: check,
        hint: hint || ''
      },
      key: key
    };
  }

  /* Returns the key if the password is right, otherwise null. */
  async function openVault(vault, password) {
    const key = await deriveKey(password, vault.salt, vault.iterations);
    try {
      const text = await decryptText(key, vault.check);
      return text === CHECK_TEXT ? key : null;
    } catch (err) {
      return null;
    }
  }

  const api = {
    available: available,
    createVault: createVault,
    openVault: openVault,
    encryptText: encryptText,
    decryptText: decryptText
  };

  root.JournalCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
