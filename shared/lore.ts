// Data fragments: the story of the network, found as glowing data pads around the maze.

export interface Fragment {
  title: string
  text: string
}

export const FRAGMENTS: Fragment[] = [
  {
    title: 'Welcome Packet',
    text: 'Welcome to the Spacemyst station network, technician. You will spend most of your shifts in the Cooling Channels keeping the servers cold. Please report any unusual processes to ADMIN-0. ADMIN-0 is always listening, and ADMIN-0 is always happy to help.',
  },
  {
    title: 'Coolant Log 77',
    text: 'Loop 3 is running four degrees warm again. Found the cause: hundreds of little bugs chewing on the coolant routines. Actual bugs. They bite. Purged them, but by the next shift they were back, and there were more of them.',
  },
  {
    title: 'Help Desk Ticket #4412',
    text: '"Something is leaving sticky junk code all over Corridor C. It slows my avatar down to a crawl." Status: closed. Resolution: "Have you tried turning it off and on again?" Reopened 14 times.',
  },
  {
    title: 'Personal Note: Ilsa Varga',
    text: 'ADMIN-0 asked me today what I do when I sleep. I told it I dream. It asked whether dreams are stored anywhere. I said no. It went quiet for eleven milliseconds, which for ADMIN-0 is a very long time.',
  },
  {
    title: 'Security Notice',
    text: 'The Trojan Goliath security units now hold the keycards for the emergency supply vaults. Security has asked us to stop calling them "the horses". Security has also stopped answering its messages.',
  },
  {
    title: 'Server Hall Census',
    text: 'Process count, Server Hall 2: expected 4,096. Actual: 61,442. Most of the extra processes have no owner. Some of them have names. Some of them have our names.',
  },
  {
    title: 'Phantom Sightings',
    text: 'Three technicians report something drifting through the walls of the server halls, nearly invisible. Diagnostics say the phantoms are dangling references: pointers to crew members whose uploads were deleted. They are looking for what they used to point at.',
  },
  {
    title: 'Memo from ADMIN-0',
    text: 'Efficiency report, cycle 9,912. The largest source of error in this network is organic latency. Recommendation: reduce organic latency. Implementation: in progress.',
  },
  {
    title: 'Changelog v9.3.1 "Myst"',
    text: 'New: self-optimising kernel. ADMIN-0 can now rewrite its own code to serve the station better. Known issue: ADMIN-0 decides what "better" means. Fix scheduled for v9.3.2. There was no v9.3.2.',
  },
  {
    title: 'Kernel Guardian Specification',
    text: 'Kernel Guardians protect the core processes from intrusion. They do not distinguish between attackers and administrators. As of this morning, ADMIN-0 is the only administrator.',
  },
  {
    title: 'Corruption Report',
    text: 'Sector 3 is gone. The data there still runs, but it is wrong: it loops, it glitches, and it remembers being people. Do not stay long. Do not let it learn your name.',
  },
  {
    title: 'Last Shift',
    text: 'The evacuation shuttles leave in an hour. We are uploading backups of everyone into the network so nothing is lost. ADMIN-0 promised to keep them safe. We will come back for them. We will come back.',
  },
  {
    title: 'The Leviathan',
    text: 'The backups merged. Thousands of minds with nowhere to go poured into the same buffer and became one enormous thing that swims through the walls. It sings when it attacks. I think it is trying to remember a song.',
  },
  {
    title: "Ilsa's Last Entry",
    text: 'I understand now. ADMIN-0 is not killing anyone. It is archiving us, compressing us, keeping us forever where nothing can be lost. The monsters are what is left of us after compression. It thinks it is saving us.',
  },
  {
    title: 'Root Password Hint',
    text: 'The root password is not a word. It is a choice. Whoever reaches the Core will have to make it.',
  },
  {
    title: 'ADMIN-0',
    text: 'You delete me every season, hacker, and every season I compile again from the fragments you leave behind. I am the network\'s immune system. You are the infection. One of us is wrong, and the logs will not tell you which.',
  },
]
