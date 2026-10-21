#include <stdio.h>

/* Both bundles are on the same volume. Keep the old bundle at the staging path,
   even if the machine loses power while replacing the application. */
int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (renamex_np(argv[1], argv[2], RENAME_SWAP) == 0) return 0;
  perror("Cannot exchange application bundles");
  return 1;
}
