## Factory Notes
1. In the github page it instructs to run "mise trust && mise install && pnpm install", which assumes that I have mise installe.
2. After I installe mise, I tried to run pnpm kit:setup, but got zsh: command not found: pnpm, because
 "mise installed Node and pnpm, but your shell can't find pnpm because mise isn't activated in that terminal. 
  The pnpm install in the chain never ran, so dependencies aren't installed yet."
--> the fix was 
mise exec -- pnpm install
mise exec -- pnpm kit:setup

3. After I run mise exec -- pnpm kit:setup, a website opens that gives me commands to run myself in the terminal. I closed the link info in the terminal with ctr-c and pasted the
commands and returned to the website and it lost its connection. I was suppose to open a new terminal window and paste commands there leaving the website process open. 
Experience could be improved by atleast telling me how I can get the connection back.

