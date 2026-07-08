/**
 * Validates that a slug is not empty and contains at least one non-hyphen character.
 * After slug normalization, empty or hyphen-only slugs indicate invalid input titles.
 *
 * @param slug - The normalized slug to validate
 * @throws Error if slug is empty or contains only hyphens
 */
export function validateSlug(slug: string): void {
  if (!slug || slug.length === 0) {
    throw new Error('Slug is empty after normalization. Title must contain at least one alphanumeric character.');
  }

  // Check if slug is only hyphens
  if (!/[a-z0-9]/.test(slug)) {
    throw new Error('Slug is empty after normalization. Title must contain at least one alphanumeric character.');
  }
}
