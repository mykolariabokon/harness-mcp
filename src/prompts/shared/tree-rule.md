- STRUCTURE IS A TREE, NOT A LIST. Every node except a root MUST carry `parent` —
  the key of the node it lives inside. Roots (`parent: null`) are the applications
  and packages of the repository, and there are only a few of them.
  Group entities under the module they belong to, screens under their application,
  components under their screen. Twenty-five nodes side by side at one level means
  the work was not done — that answer is rejected and sent back.
