# Mixamo clips for Frontier

Download the clips below from <https://www.mixamo.com> as **FBX Binary (.fbx)**, with
**In Place** on, **30 fps**, no keyframe reduction, and the **same character** for every clip.

Put the files in this folder, named exactly as listed (rename them after download):

| File | Mixamo clip |
|---|---|
| `Idle.fbx` | Idle |
| `Idle_Gun_Pointing.fbx` | Idle Gun Pointing |
| `Walk.fbx` | Walking |
| `Run.fbx` | Running |
| `Sprint.fbx` | Sprint |
| `Strafe_Left.fbx` | Left Strafe Walking |
| `Strafe_Right.fbx` | Right Strafe Walking |
| `Rifle_Aim_Idle.fbx` | Rifle Aiming Idle |
| `Rifle_Walk.fbx` | Rifle Walk |
| `Rifle_Run.fbx` | Rifle Run |
| `Firing_Pistol.fbx` | Firing Pistol |
| `Firing_Rifle.fbx` | Firing Rifle |
| `Reloading_Pistol.fbx` | Reloading Pistol |
| `Reloading_Rifle.fbx` | Reloading Rifle |
| `Crouch_Idle.fbx` | Crouched Idle |
| `Crouch_Walk.fbx` | Crouch Walk |
| `Crouch_Aim.fbx` | Crouch Aim |
| `Jump.fbx` | Jumping |
| `Fall.fbx` | Falling |
| `Land.fbx` | Landing |
| `Hit_Reaction_Front.fbx` | Hit Reaction |
| `Hit_Reaction_Back.fbx` | Hit Reaction Back |
| `Death_Front.fbx` | Dying |
| `Death_Back.fbx` | Dying Backwards |

The files are art sources, not shipped assets: once they are here, run the retarget step and it
will write `public/experiments/out-west/3d/models/moves.glb` (and the ragdoll reference pose) for
the client to load.
