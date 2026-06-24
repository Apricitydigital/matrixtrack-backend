const crypto = require('crypto');
require('dotenv').config();

const ALGORITHM = 'aes-256-cbc';
const ENCRYPTION_KEY = process.env.AADHAR_ENCRYPTION_KEY; // Must be 32 bytes (256 bits)
const IV_LENGTH = 16; // For AES, this is always 16 bytes

/**
 * Encrypts a plaintext string (e.g. Aadhar number) using AES-256-CBC.
 * @param {string} text - The plaintext to encrypt
 * @returns {string} - The encrypted string format: iv:encryptedData
 */
function encryptAadhar(text) {
  if (!text) return text;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    throw new Error('AADHAR_ENCRYPTION_KEY environment variable is not set or not 32 bytes long');
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return iv.toString('hex') + ':' + encrypted;
}

/**
 * Decrypts a ciphertext string using AES-256-CBC.
 * @param {string} text - The ciphertext to decrypt (format: iv:encryptedData)
 * @returns {string} - The decrypted plaintext
 */
function decryptAadhar(text) {
  if (!text) return text;
  if (!ENCRYPTION_KEY || ENCRYPTION_KEY.length !== 32) {
    throw new Error('AADHAR_ENCRYPTION_KEY environment variable is not set or not 32 bytes long');
  }

  const textParts = text.split(':');
  if (textParts.length !== 2) {
    throw new Error('Invalid encrypted format');
  }

  const iv = Buffer.from(textParts[0], 'hex');
  const encryptedText = Buffer.from(textParts[1], 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(ENCRYPTION_KEY), iv);
  
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

module.exports = {
  encryptAadhar,
  decryptAadhar
};
