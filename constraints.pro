% The package must have a name.
\+ gen_enforced_field(WorkspaceCwd, 'name', null).

% The package must have a description.
\+ gen_enforced_field(WorkspaceCwd, 'description', null).
% The description cannot end with a period.
gen_enforced_field(WorkspaceCwd, 'description', DescriptionWithoutTrailingPeriod) :-
  workspace_field(WorkspaceCwd, 'description', Description),
  atom_length(Description, Length),
  LengthLessOne is Length - 1,
  sub_atom(Description, LengthLessOne, 1, 0, LastCharacter),
  sub_atom(Description, 0, LengthLessOne, 1, DescriptionWithoutPossibleTrailingPeriod),
  (
    LastCharacter == '.' ->
      DescriptionWithoutTrailingPeriod = DescriptionWithoutPossibleTrailingPeriod ;
      DescriptionWithoutTrailingPeriod = Description
  ).

% If a dependency is listed under "dependencies", it should not be listed under
% "devDependencies".
gen_enforced_dependency(WorkspaceCwd, DependencyIdent, null, DependencyType) :-
  workspace_has_dependency(WorkspaceCwd, DependencyIdent, DependencyRange, 'dependencies'),
  workspace_has_dependency(WorkspaceCwd, DependencyIdent, DependencyRange, DependencyType),
  DependencyType == 'devDependencies'.

% The package must specify a minimum Node version of 16.
gen_enforced_field(WorkspaceCwd, 'engines.node', '>=16.0.0').
