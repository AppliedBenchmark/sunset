Deliberately violating files for the boundary self-test (`test/boundaries.test.ts`). Each file breaks one
layer rule in CONTRIBUTING.md ("Layout"), and the test expects Biome or oxlint to report it. The main lint run excludes this
directory.
