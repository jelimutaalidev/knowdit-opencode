export type ContestRef = {
  localId: number;
  c4Id: number | null;
  slug: string;
  title: string;
  repoDir: string;
  reportPath: string | null;
};

export type Selection = {
  selected: ContestRef[];
  excluded: { localId: number; reason: string }[];
};
