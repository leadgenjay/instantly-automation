import { randomBytes } from "crypto";

/**
 * Generate a secure random password
 * @param length Password length (default: 16)
 * @returns A secure random password with mixed characters
 */
export function generateSecurePassword(length: number = 16): string {
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const numbers = "0123456789";
  const special = "!@#$%^&*";

  const allChars = lowercase + uppercase + numbers + special;

  // Ensure at least one character from each category
  let password = "";
  password += lowercase[randomInt(lowercase.length)];
  password += uppercase[randomInt(uppercase.length)];
  password += numbers[randomInt(numbers.length)];
  password += special[randomInt(special.length)];

  // Fill the rest with random characters
  for (let i = password.length; i < length; i++) {
    password += allChars[randomInt(allChars.length)];
  }

  // Shuffle the password
  return shuffleString(password);
}

/**
 * Generate a random integer between 0 and max (exclusive)
 */
function randomInt(max: number): number {
  const bytes = randomBytes(4);
  const value = bytes.readUInt32BE(0);
  return value % max;
}

/**
 * Shuffle a string randomly
 */
function shuffleString(str: string): string {
  const arr = str.split("");
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}
